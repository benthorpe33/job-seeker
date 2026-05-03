import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ProfileDiffResult, RejectionPatterns } from "@job-seeker/shared";

import {
  applyProfileDiff,
  getRejectionPatterns,
  startProfileDiffJob,
} from "../lib/api";
import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { useJobStore } from "../lib/store";

const PROFILE_DIFF_PREFIX = "PROFILE_DIFF: ";
const PROFILE_DIFF_DONE_PREFIX = "PROFILE_DIFF_DONE:";
const PROFILE_DIFF_FAILED_PREFIX = "PROFILE_DIFF_FAILED:";

const BAND_COLORS: Record<string, string> = {
  "3.5-3.9": "#f97316",
  "4.0-4.4": "#10b981",
  ">=4.5": "#22d3ee",
  unscored: "#64748b",
};

function parseProfileDiffLine(line: string): ProfileDiffResult | null {
  if (!line.startsWith(PROFILE_DIFF_PREFIX)) return null;
  const payload = line.slice(PROFILE_DIFF_PREFIX.length).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const diff = typeof parsed.diff === "string" ? parsed.diff : null;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
    const sections = Array.isArray(parsed.sections)
      ? (parsed.sections as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    if (!diff) return null;
    return { diff, rationale, sections };
  } catch {
    return null;
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-slate-400";
  if (line.startsWith("@@")) return "text-cyan-300";
  if (line.startsWith("+")) return "text-emerald-300";
  if (line.startsWith("-")) return "text-rose-300";
  return "text-slate-300";
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="max-h-[480px] overflow-auto rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={diffLineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function Rejections() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<RejectionPatterns>({
    queryKey: ["rejection-patterns"],
    queryFn: getRejectionPatterns,
  });

  const registerJob = useJobStore((s) => s.registerJob);
  const activeJobs = useJobStore((s) => s.activeJobs);

  const [draftJobId, setDraftJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDiffResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // Watch the active job's lines for our PROFILE_DIFF: marker.
  const seenLineIdRef = useRef<number>(-1);
  useEffect(() => {
    if (!draftJobId) return;
    const job = activeJobs.get(draftJobId);
    if (!job) return;
    for (const line of job.lines) {
      if (line.id <= seenLineIdRef.current) continue;
      seenLineIdRef.current = line.id;
      if (line.stream !== "stdout") continue;
      const parsed = parseProfileDiffLine(line.line);
      if (parsed) {
        setDraft(parsed);
        setDraftError(null);
        continue;
      }
      if (line.line.startsWith(PROFILE_DIFF_FAILED_PREFIX)) {
        setDraftError(line.line.slice(PROFILE_DIFF_FAILED_PREFIX.length).trim() || "drafter failed");
        continue;
      }
      if (line.line.startsWith(PROFILE_DIFF_DONE_PREFIX)) {
        setDrafting(false);
      }
    }
    if (job.status !== "running") {
      setDrafting(false);
    }
  }, [draftJobId, activeJobs]);

  const handleDraft = useCallback(async () => {
    setDraftError(null);
    setDraft(null);
    setSavedToast(null);
    setDrafting(true);
    seenLineIdRef.current = -1;
    try {
      const job = await startProfileDiffJob();
      setDraftJobId(job.jobId);
      registerJob({ jobId: job.jobId, kind: job.kind, startedAt: job.startedAt });
      ensureJobSubscription(job.jobId);
    } catch (err) {
      setDrafting(false);
      setDraftError(err instanceof Error ? err.message : String(err));
    }
  }, [registerJob]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setDraftError(null);
    try {
      const res = await applyProfileDiff(draft.diff);
      setSavedToast(`Profile updated (${res.bytesWritten} bytes).`);
      setDraft(null);
      setDraftJobId(null);
      seenLineIdRef.current = -1;
      await queryClient.invalidateQueries({ queryKey: ["rejection-patterns"] });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, queryClient]);

  const handleDiscard = useCallback(() => {
    setDraft(null);
    setDraftJobId(null);
    setDraftError(null);
    setSavedToast(null);
    seenLineIdRef.current = -1;
  }, []);

  if (isLoading) {
    return <div className="text-sm text-slate-400">Loading rejection patterns…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
        Failed to load rejection patterns: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Rejection patterns</h2>
          <p className="text-xs text-slate-500">
            {data.totalRejections} rejection signal{data.totalRejections === 1 ? "" : "s"} aggregated from{" "}
            <code className="text-slate-400">data/rejection-feedback.tsv</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDraft}
          disabled={drafting}
          className={
            drafting
              ? "rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-500"
              : "rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
          }
        >
          {drafting ? "Drafting…" : "Draft profile update"}
        </button>
      </header>

      {savedToast && (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {savedToast}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Top reason keywords</h3>
          {data.topReasonKeywords.length === 0 ? (
            <p className="text-xs text-slate-500">No keywords with count ≥ 2 yet.</p>
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <BarChart
                  data={data.topReasonKeywords}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 16, bottom: 4 }}
                >
                  <XAxis type="number" stroke="#94a3b8" fontSize={11} />
                  <YAxis
                    dataKey="keyword"
                    type="category"
                    stroke="#94a3b8"
                    fontSize={11}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      border: "1px solid #334155",
                      fontSize: 12,
                    }}
                    cursor={{ fill: "rgba(148,163,184,0.1)" }}
                  />
                  <Bar dataKey="count" fill="#38bdf8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Score-band distribution</h3>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={data.scoreBands}
                  dataKey="count"
                  nameKey="band"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={(entry) => `${entry.band}: ${entry.count}`}
                >
                  {data.scoreBands.map((entry) => (
                    <Cell key={entry.band} fill={BAND_COLORS[entry.band] ?? "#64748b"} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 11, color: "#cbd5e1" }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Top companies by rejection category</h3>
        {data.topCompaniesByReason.length === 0 ? (
          <p className="text-xs text-slate-500">No categorized rejections yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.topCompaniesByReason.map((cat) => (
              <div key={cat.reasonCategory} className="rounded border border-slate-700 p-2">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {cat.reasonCategory}
                </h4>
                <ul className="space-y-1 text-xs text-slate-300">
                  {cat.companies.map((c) => (
                    <li key={c.company} className="flex justify-between">
                      <span>{c.company}</span>
                      <span className="text-slate-500">×{c.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Recent rejections</h3>
        {data.recentReasons.length === 0 ? (
          <p className="text-xs text-slate-500">No rejections logged yet.</p>
        ) : (
          <ul className="space-y-2 text-xs text-slate-300">
            {data.recentReasons.map((r, i) => (
              <li key={`${r.ts}-${i}`} className="border-l-2 border-slate-700 pl-3">
                <div className="text-slate-200">
                  <span className="font-medium">{r.company}</span>
                  <span className="text-slate-500"> · {r.role}</span>
                  {r.score !== null && (
                    <span className="text-slate-500"> · {r.score.toFixed(1)}</span>
                  )}
                </div>
                <div className="text-slate-400">{r.reason}</div>
                <div className="mt-0.5 text-[10px] text-slate-600">{r.ts}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {draftError && (
        <div className="rounded-md border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
          {draftError}
        </div>
      )}

      {draft && (
        <section className="space-y-3 rounded-md border border-emerald-700/50 bg-emerald-950/20 p-4">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-emerald-200">Proposed diff to modes/_profile.md</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className={
                  saving
                    ? "rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-500"
                    : "rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                }
              >
                {saving ? "Saving…" : "Save to modes/_profile.md"}
              </button>
              <button
                type="button"
                onClick={handleDiscard}
                disabled={saving}
                className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                Discard
              </button>
            </div>
          </header>
          {draft.rationale && (
            <p className="text-xs text-slate-300">
              <span className="font-semibold text-slate-200">Rationale:</span> {draft.rationale}
            </p>
          )}
          {draft.sections.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {draft.sections.map((s) => (
                <span
                  key={s}
                  className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
          <DiffPreview diff={draft.diff} />
        </section>
      )}
    </div>
  );
}

export default Rejections;
