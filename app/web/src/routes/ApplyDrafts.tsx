import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import type {
  DraftAnswer,
  DraftFile,
  ReportDetail,
  ScrapedField,
  ScrapeResult,
} from "@job-seeker/shared";

import {
  getDrafts,
  getReport,
  patchDrafts,
  startDraftJob,
} from "../lib/api";
import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { useJobStore } from "../lib/store";
import { DraftsList } from "../components/applyDrafts/DraftsList";
import { SafetyBanner } from "../components/applyDrafts/SafetyBanner";
import { ScrapePanel } from "../components/applyDrafts/ScrapePanel";

const PERSIST_DEBOUNCE_MS = 800;

const DRAFT_LINE_PREFIX = "DRAFT: ";
const DONE_LINE_PREFIX = "DRAFT_ANSWERS_DONE:";
const FAILED_LINE_PREFIX = "DRAFT_ANSWERS_FAILED:";

type JobLineEvent = {
  id: number;
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

type StreamHandlers = {
  onDraft: (answer: DraftAnswer) => void;
  onDone: (count: number) => void;
  onFailed: (reason: string) => void;
  onClose: () => void;
};

function parseDraftLine(line: string): DraftAnswer | null {
  if (!line.startsWith(DRAFT_LINE_PREFIX)) return null;
  const payload = line.slice(DRAFT_LINE_PREFIX.length).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const fieldId = typeof parsed.fieldId === "string" ? parsed.fieldId : null;
    const answer = typeof parsed.answer === "string" ? parsed.answer : null;
    if (!fieldId || answer === null) return null;
    const charCount =
      typeof parsed.charCount === "number" && Number.isFinite(parsed.charCount)
        ? Math.trunc(parsed.charCount)
        : answer.length;
    const warnings = Array.isArray(parsed.warnings)
      ? (parsed.warnings as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    return { fieldId, answer, charCount, warnings };
  } catch {
    return null;
  }
}

function subscribeToDraftJob(jobId: string, h: StreamHandlers): () => void {
  const url = `/sse/jobs/${encodeURIComponent(jobId)}`;
  const es = new EventSource(url);

  function handleLine(ev: MessageEvent) {
    try {
      const data = JSON.parse(ev.data) as JobLineEvent;
      if (data.stream !== "stdout") return;
      const draft = parseDraftLine(data.line);
      if (draft) {
        h.onDraft(draft);
        return;
      }
      if (data.line.startsWith(DONE_LINE_PREFIX)) {
        const rest = data.line.slice(DONE_LINE_PREFIX.length).trim();
        const n = Number.parseInt(rest, 10);
        h.onDone(Number.isFinite(n) ? n : 0);
        return;
      }
      if (data.line.startsWith(FAILED_LINE_PREFIX)) {
        const reason = data.line.slice(FAILED_LINE_PREFIX.length).trim();
        h.onFailed(reason);
      }
    } catch {
      /* ignore */
    }
  }

  function handleDone() {
    es.close();
    h.onClose();
  }

  es.addEventListener("line", handleLine as EventListener);
  es.addEventListener("done", handleDone as EventListener);
  return () => {
    es.removeEventListener("line", handleLine as EventListener);
    es.removeEventListener("done", handleDone as EventListener);
    es.close();
  };
}

function useDebouncedCallback<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): (...args: TArgs) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  return useCallback(
    (...args: TArgs) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fnRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  );
}

export function ApplyDrafts() {
  const { reportId = "" } = useParams<{ reportId: string }>();

  const reportQuery = useQuery<ReportDetail>({
    queryKey: ["report", reportId],
    queryFn: () => getReport(reportId),
    refetchOnWindowFocus: false,
    enabled: Boolean(reportId),
  });

  const draftsQuery = useQuery<DraftFile | null>({
    queryKey: ["drafts", reportId],
    queryFn: () => getDrafts(reportId),
    refetchOnWindowFocus: false,
    enabled: Boolean(reportId),
  });

  const reportApplyUrl = reportQuery.data?.header.url ?? null;

  // Local state.
  const [fields, setFields] = useState<ScrapedField[]>([]);
  const [draftsByField, setDraftsByField] = useState<Record<string, DraftAnswer>>({});
  const [applyUrl, setApplyUrl] = useState<string | null>(null);
  const [streamingFieldId, setStreamingFieldId] = useState<string | null>(null);
  const [regeneratingFieldId, setRegeneratingFieldId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastPersistedRef = useRef<string>("");

  // Hydrate from server data.
  useEffect(() => {
    if (reportApplyUrl) setApplyUrl((cur) => cur ?? reportApplyUrl);
  }, [reportApplyUrl]);

  useEffect(() => {
    const file = draftsQuery.data;
    if (!file) return;
    if (file.applyUrl) setApplyUrl((cur) => cur ?? file.applyUrl);
    const map: Record<string, DraftAnswer> = {};
    for (const d of file.drafts) {
      map[d.fieldId] = d;
    }
    setDraftsByField(map);
    // If there are persisted drafts but no scraped fields yet, synthesize a
    // minimal field list from the draft entries so the user can edit/copy.
    if (file.drafts.length > 0) {
      setFields((cur) =>
        cur.length > 0
          ? cur
          : file.drafts.map<ScrapedField>((d) => ({
              id: d.fieldId,
              label: d.fieldId,
              type: "textarea",
              required: false,
            })),
      );
    }
    lastPersistedRef.current = JSON.stringify(file.drafts);
  }, [draftsQuery.data]);

  // Persist edits (debounced PATCH).
  const persistDrafts = useDebouncedCallback(async (next: Record<string, DraftAnswer>) => {
    const arr = Object.values(next);
    const serialized = JSON.stringify(arr);
    if (serialized === lastPersistedRef.current) return;
    if (arr.length === 0) return;
    try {
      const file = await patchDrafts(reportId, arr);
      lastPersistedRef.current = JSON.stringify(file.drafts);
      setStatusMessage("Saved.");
      setTimeout(() => setStatusMessage(null), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Failed to save edits: ${msg}`);
    }
  }, PERSIST_DEBOUNCE_MS);

  function applyDraftToState(d: DraftAnswer) {
    setDraftsByField((cur) => {
      const next = { ...cur, [d.fieldId]: d };
      // Treat streamed/regenerated server output as the new persisted baseline.
      lastPersistedRef.current = JSON.stringify(Object.values(next));
      return next;
    });
  }

  function handleScrapeResult(result: ScrapeResult) {
    setFields(result.fields);
    setErrorMessage(null);
    setStatusMessage(`Loaded ${result.fields.length} field(s) from ${result.ats}.`);
    setTimeout(() => setStatusMessage(null), 2000);
  }

  function handleAnswerChange(fieldId: string, next: string) {
    setDraftsByField((cur) => {
      const prior = cur[fieldId];
      const updated: DraftAnswer = {
        fieldId,
        answer: next,
        charCount: next.length,
        warnings: prior?.warnings ?? [],
      };
      const merged = { ...cur, [fieldId]: updated };
      void persistDrafts(merged);
      return merged;
    });
  }

  // Subscribe to a draft-answers job.
  const subscribeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      if (subscribeRef.current) subscribeRef.current();
      subscribeRef.current = null;
    };
  }, []);

  function startStream(jobId: string, targetFieldId: string) {
    if (subscribeRef.current) {
      subscribeRef.current();
      subscribeRef.current = null;
    }
    setRegeneratingFieldId(targetFieldId);
    setStreamingFieldId(targetFieldId);

    subscribeRef.current = subscribeToDraftJob(jobId, {
      onDraft: (d) => {
        applyDraftToState(d);
        if (d.fieldId === targetFieldId) setStreamingFieldId(null);
      },
      onDone: (count) => {
        setStatusMessage(`Drafted ${count} answer(s).`);
        setTimeout(() => setStatusMessage(null), 2500);
      },
      onFailed: (reason) => {
        setErrorMessage(`Drafting failed: ${reason}`);
      },
      onClose: () => {
        setStreamingFieldId(null);
        setRegeneratingFieldId(null);
        subscribeRef.current = null;
      },
    });
  }

  async function handleRegenerate(fieldId: string) {
    const target = fields.find((f) => f.id === fieldId);
    if (!target) return;
    setErrorMessage(null);
    try {
      const res = await startDraftJob({
        reportId,
        fields: [target],
        applyUrl: applyUrl ?? undefined,
      });
      useJobStore.getState().registerJob({
        jobId: res.jobId,
        kind: res.kind,
        startedAt: res.startedAt,
      });
      ensureJobSubscription(res.jobId);
      startStream(res.jobId, fieldId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Failed to regenerate: ${msg}`);
    }
  }

  const totalDrafts = useMemo(
    () => Object.keys(draftsByField).length,
    [draftsByField],
  );

  if (!reportId) {
    return (
      <>
        <SafetyBanner />
        <div className="p-6 text-rose-300">Missing report ID.</div>
      </>
    );
  }
  if (reportQuery.isLoading) {
    return (
      <>
        <SafetyBanner />
        <p className="p-6 text-slate-400">Loading report…</p>
      </>
    );
  }
  if (reportQuery.isError || !reportQuery.data) {
    return (
      <>
        <SafetyBanner />
        <div className="space-y-3 p-6">
          <p className="text-rose-300">Report not found.</p>
          <Link className="text-sky-400 hover:underline" to="/">
            ← back to tracker
          </Link>
        </div>
      </>
    );
  }

  const r = reportQuery.data;
  const showScrapePanel = fields.length === 0;

  return (
    <>
      <SafetyBanner />
      <div className="mt-4 flex flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/reports/${encodeURIComponent(reportId)}`}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              ← back to report
            </Link>
            <h1 className="mt-1 text-lg font-semibold text-slate-100">
              Draft answers · #{r.num} {r.slug}
            </h1>
            <p className="text-xs text-slate-500">
              Fields: {fields.length} · Drafts: {totalDrafts}
              {applyUrl && (
                <>
                  {" · "}
                  <span className="font-mono text-slate-600">
                    {applyUrl.length > 80 ? applyUrl.slice(0, 80) + "…" : applyUrl}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            {applyUrl && (
              <a
                href={applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border border-slate-700 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
              >
                Open application URL
              </a>
            )}
          </div>
        </header>

        {statusMessage && (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {statusMessage}
          </p>
        )}
        {errorMessage && (
          <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {errorMessage}
          </p>
        )}

        {showScrapePanel && (
          <ScrapePanel applyUrl={applyUrl} onResult={handleScrapeResult} />
        )}

        {!showScrapePanel && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setFields([]);
                setStatusMessage("Cleared scraped fields. Run scrape again to reload.");
                setTimeout(() => setStatusMessage(null), 2000);
              }}
              className="rounded border border-slate-700 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
            >
              Re-scrape
            </button>
          </div>
        )}

        {fields.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Questions ({fields.length}) · Drafts ({totalDrafts})
            </h2>
            <DraftsList
              fields={fields}
              drafts={draftsByField}
              regeneratingFieldId={regeneratingFieldId}
              streamingFieldId={streamingFieldId}
              onChangeAnswer={handleAnswerChange}
              onRegenerate={(id) => void handleRegenerate(id)}
            />
          </section>
        )}
      </div>
    </>
  );
}
