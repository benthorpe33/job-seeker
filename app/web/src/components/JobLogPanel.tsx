import { useEffect, useRef, useState } from "react";

import { cancelJob } from "../lib/api";
import { useJobStore } from "../lib/store";

export function JobLogPanel() {
  const panelOpen = useJobStore((s) => s.panelOpen);
  const visibleJobId = useJobStore((s) => s.visibleJobId);
  const activeJobs = useJobStore((s) => s.activeJobs);
  const closePanel = useJobStore((s) => s.closePanel);
  const openPanel = useJobStore((s) => s.openPanel);

  const job = visibleJobId ? activeJobs.get(visibleJobId) : null;
  const logRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.lines.length, autoScroll]);

  if (!panelOpen) return null;

  return (
    <div className="fixed bottom-0 right-0 z-40 flex h-[60vh] w-full max-w-3xl flex-col rounded-tl-lg border border-b-0 border-r-0 border-slate-700 bg-slate-950 shadow-2xl">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-slate-100">Job log</h3>
          {job && (
            <span className="rounded border border-slate-700 px-2 py-0.5 font-mono text-xs text-slate-400">
              {job.kind} · {job.status}
              {job.exitCode !== undefined && job.exitCode !== null
                ? ` · exit ${job.exitCode}`
                : ""}
            </span>
          )}
          <select
            value={visibleJobId ?? ""}
            onChange={(e) => openPanel(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">(none)</option>
            {Array.from(activeJobs.values()).map((j) => (
              <option key={j.jobId} value={j.jobId}>
                {j.kind} · {j.jobId.slice(0, 8)} · {j.status}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {job?.status === "running" && (
            <button
              type="button"
              className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20"
              onClick={() => void cancelJob(job.jobId)}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={closePanel}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </header>
      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          setAutoScroll(atBottom);
        }}
        className="grow overflow-y-auto bg-black px-3 py-2 font-mono text-xs leading-relaxed text-slate-300"
      >
        {!job && <p className="text-slate-500">No job selected.</p>}
        {job && job.lines.length === 0 && (
          <p className="text-slate-500">Waiting for output…</p>
        )}
        {job?.lines.map((l) => (
          <div
            key={l.id}
            className={l.stream === "stderr" ? "text-rose-300" : undefined}
          >
            <span className="select-none text-slate-600">{l.id.toString().padStart(4, " ")} </span>
            {l.line}
          </div>
        ))}
      </div>
    </div>
  );
}
