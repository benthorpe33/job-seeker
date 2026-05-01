import { useEffect, useRef, useState } from "react";

import type {
  PipelineEvent,
  PipelineRecord,
  PipelineStage,
} from "@job-seeker/shared";

import {
  getLinkedinPipeline,
  resumeLinkedinPipeline,
  startLinkedinPipeline,
} from "../lib/api";
import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { useJobStore } from "../lib/store";
import { PipelineStepper } from "./PipelineStepper";

type Props = {
  open: boolean;
  onClose: () => void;
};

function applyStageUpdate(
  rec: PipelineRecord,
  stage: PipelineStage,
): PipelineRecord {
  const stages = rec.stages.map((s) =>
    s.stageNum === stage.stageNum ? stage : s,
  );
  return { ...rec, stages };
}

export function LinkedinPipelineModal({ open, onClose }: Props) {
  const [pipeline, setPipeline] = useState<PipelineRecord | null>(null);
  const [prefetchJds, setPrefetchJds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registerJob = useJobStore((s) => s.registerJob);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!open) {
      // Closing the modal closes the SSE — pipeline keeps running on the
      // server, but logs stop streaming until reopen.
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      return;
    }
    // Reopening with an in-flight pipeline: re-subscribe so logs keep flowing.
    if (pipeline && !esRef.current && pipeline.status === "running") {
      subscribe(pipeline.pipelineId);
    }
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
    // pipeline intentionally omitted — re-subscribe is gated on `open` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function subscribe(pipelineId: string) {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`/sse/pipelines/${encodeURIComponent(pipelineId)}`);
    esRef.current = es;

    const handleSnapshot = (raw: string) => {
      try {
        const snap = JSON.parse(raw) as PipelineRecord;
        setPipeline(snap);
        for (const stage of snap.stages) {
          if (stage.jobId) {
            registerJob({
              jobId: stage.jobId,
              kind: stage.kind ?? "scan",
              startedAt: stage.startedAt ?? new Date().toISOString(),
            });
            ensureJobSubscription(stage.jobId);
          }
        }
      } catch {
        /* ignore */
      }
    };
    const handleEvent = (raw: string) => {
      try {
        const ev = JSON.parse(raw) as PipelineEvent;
        if (ev.type === "stage:start") {
          setPipeline((cur) => (cur ? applyStageUpdate(cur, ev.stage) : cur));
          if (ev.stage.jobId && ev.stage.kind) {
            registerJob({
              jobId: ev.stage.jobId,
              kind: ev.stage.kind,
              startedAt: ev.stage.startedAt ?? new Date().toISOString(),
            });
            ensureJobSubscription(ev.stage.jobId);
          }
        } else if (ev.type === "stage:done") {
          setPipeline((cur) => (cur ? applyStageUpdate(cur, ev.stage) : cur));
        } else if (ev.type === "pipeline:done") {
          setPipeline(ev.pipeline);
        }
      } catch {
        /* ignore */
      }
    };

    es.addEventListener("snapshot", (e) => handleSnapshot((e as MessageEvent).data));
    es.addEventListener("stage:start", (e) =>
      handleEvent((e as MessageEvent).data),
    );
    es.addEventListener("stage:done", (e) =>
      handleEvent((e as MessageEvent).data),
    );
    es.addEventListener("pipeline:done", (e) =>
      handleEvent((e as MessageEvent).data),
    );
  }

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const res = await startLinkedinPipeline({ prefetchJds });
      const initial: PipelineRecord = {
        pipelineId: res.pipelineId,
        startedAt: res.startedAt,
        finishedAt: null,
        status: "running",
        failedAtStage: null,
        prefetchJds,
        stages: res.stages,
      };
      setPipeline(initial);
      subscribe(res.pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleResume() {
    if (!pipeline) return;
    setBusy(true);
    setError(null);
    try {
      // Refresh state first in case the SSE event was missed.
      const fresh = await getLinkedinPipeline(pipeline.pipelineId);
      const failed = fresh.stages.find((s) => s.status === "failed");
      const fromStage = failed?.stageNum;
      await resumeLinkedinPipeline(pipeline.pipelineId, fromStage);
      subscribe(pipeline.pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const canResume =
    pipeline?.status === "failed" && pipeline.failedAtStage !== null;
  const isRunning = pipeline?.status === "running";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950 p-5 shadow-2xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              LinkedIn pipeline
            </h2>
            <p className="text-xs text-slate-500">
              Pulls saved jobs → resolves ATS URLs → appends to pipeline.md →
              builds batch → evaluates → merges → verifies. State is in-memory:
              a server restart will require restarting from stage 1.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </header>

        {!pipeline && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={prefetchJds}
                onChange={(e) => setPrefetchJds(e.target.checked)}
                className="size-4 rounded border-slate-700 bg-slate-900"
              />
              Pre-fetch JDs (Greenhouse/Ashby APIs)
            </label>
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={busy}
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              Start pipeline
            </button>
          </div>
        )}

        {pipeline && (
          <>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                pipelineId: <span className="font-mono">{pipeline.pipelineId.slice(0, 8)}</span>
              </span>
              <span className="capitalize">
                status: <span className="font-medium text-slate-300">{pipeline.status}</span>
                {pipeline.failedAtStage !== null && (
                  <> · failed at stage {pipeline.failedAtStage}</>
                )}
              </span>
            </div>
            <PipelineStepper pipeline={pipeline} />
            <div className="flex items-center gap-3">
              {canResume && (
                <button
                  type="button"
                  onClick={() => void handleResume()}
                  disabled={busy || isRunning}
                  className="rounded border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                >
                  Resume from stage {pipeline.failedAtStage}
                </button>
              )}
              {pipeline.status === "completed" && (
                <button
                  type="button"
                  onClick={() => {
                    setPipeline(null);
                    if (esRef.current) {
                      esRef.current.close();
                      esRef.current = null;
                    }
                  }}
                  className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Run another
                </button>
              )}
            </div>
          </>
        )}

        {error && (
          <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
