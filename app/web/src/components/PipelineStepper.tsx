import { useEffect, useState } from "react";

import type { PipelineRecord, PipelineStage } from "@job-seeker/shared";

import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { useJobStore } from "../lib/store";

const STATUS_ICON: Record<PipelineStage["status"], string> = {
  pending: "○",
  running: "◐",
  completed: "✓",
  failed: "✕",
  skipped: "—",
};

const STATUS_COLOR: Record<PipelineStage["status"], string> = {
  pending: "text-slate-500",
  running: "text-amber-300",
  completed: "text-emerald-400",
  failed: "text-rose-400",
  skipped: "text-slate-600",
};

function durationLabel(stage: PipelineStage): string | null {
  if (!stage.startedAt) return null;
  const end = stage.finishedAt ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(stage.startedAt).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m${remSec.toString().padStart(2, "0")}s`;
}

function StageRow({ stage }: { stage: PipelineStage }) {
  const [expanded, setExpanded] = useState(false);
  const job = useJobStore((s) =>
    stage.jobId ? s.activeJobs.get(stage.jobId) ?? null : null,
  );

  useEffect(() => {
    if (stage.jobId) ensureJobSubscription(stage.jobId);
  }, [stage.jobId]);

  const dur = durationLabel(stage);
  const canExpand = stage.jobId !== null;

  return (
    <li className="rounded border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${
          canExpand ? "hover:bg-slate-900/70" : "cursor-default"
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`font-mono text-base ${STATUS_COLOR[stage.status]}`}>
            {STATUS_ICON[stage.status]}
          </span>
          <span className="font-mono text-xs text-slate-500">
            stage {stage.stageNum}
          </span>
          <span className="truncate text-sm text-slate-200">{stage.name}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0 text-xs">
          {dur && <span className="font-mono text-slate-500">{dur}</span>}
          <span className={`font-medium ${STATUS_COLOR[stage.status]}`}>
            {stage.status}
          </span>
          {canExpand && (
            <span className="text-slate-600">{expanded ? "▴" : "▾"}</span>
          )}
        </div>
      </button>
      {stage.errorMessage && stage.status !== "skipped" && (
        <p className="border-t border-slate-800 px-3 py-2 text-xs text-rose-300">
          {stage.errorMessage}
        </p>
      )}
      {stage.errorMessage && stage.status === "skipped" && (
        <p className="border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
          {stage.errorMessage}
        </p>
      )}
      {expanded && job && (
        <div className="max-h-64 overflow-y-auto border-t border-slate-800 bg-black px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300">
          {job.lines.length === 0 && (
            <p className="text-slate-500">Waiting for output…</p>
          )}
          {job.lines.map((l) => (
            <div
              key={l.id}
              className={l.stream === "stderr" ? "text-rose-300" : undefined}
            >
              <span className="select-none text-slate-600">
                {l.id.toString().padStart(4, " ")}{" "}
              </span>
              {l.line}
            </div>
          ))}
        </div>
      )}
      {expanded && !job && stage.jobId && (
        <p className="border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
          Logs not yet streaming… (stage was likely re-loaded after page refresh)
        </p>
      )}
    </li>
  );
}

export function PipelineStepper({ pipeline }: { pipeline: PipelineRecord }) {
  return (
    <ol className="flex flex-col gap-2">
      {pipeline.stages.map((s) => (
        <StageRow key={s.stageNum} stage={s} />
      ))}
    </ol>
  );
}
