import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { JobListResponse, JobRecord } from "@job-seeker/shared";

import { cancelAllJobs, cancelJob, getJobLog, listJobs } from "../lib/api";
import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { useJobStore } from "../lib/store";
import { formatDuration, formatRelative, useNow } from "../lib/jobs";

export function Jobs() {
  const qc = useQueryClient();
  const now = useNow(1000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);

  const query = useQuery<JobListResponse>({
    queryKey: ["jobs", "all"],
    queryFn: () => listJobs("all"),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 500,
  });

  const jobs = query.data?.jobs ?? [];
  const runningCount = useMemo(
    () => jobs.filter((j) => j.status === "running").length,
    [jobs],
  );

  const registerJob = useJobStore((s) => s.registerJob);
  const appendLine = useJobStore((s) => s.appendLine);
  const finishJob = useJobStore((s) => s.finishJob);
  const openPanel = useJobStore((s) => s.openPanel);
  const activeJobs = useJobStore((s) => s.activeJobs);

  async function handleViewLog(job: JobRecord) {
    if (activeJobs.has(job.jobId)) {
      openPanel(job.jobId);
      if (job.status === "running") ensureJobSubscription(job.jobId);
      return;
    }
    try {
      const log = await getJobLog(job.jobId);
      registerJob({
        jobId: job.jobId,
        kind: job.kind,
        startedAt: job.startedAt,
      });
      for (const ev of log.events) {
        appendLine(job.jobId, ev);
      }
      if (log.status !== "running") {
        finishJob(job.jobId, log.status, log.exitCode);
      } else {
        ensureJobSubscription(job.jobId);
      }
      openPanel(job.jobId);
    } catch (err) {
      alert(`Failed to load log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleCancel(jobId: string) {
    try {
      await cancelJob(jobId);
      await qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      alert(`Failed to cancel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleCancelAll() {
    setCancellingAll(true);
    try {
      await cancelAllJobs();
      await qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      alert(
        `Failed to cancel all: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCancellingAll(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link
            to="/"
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← Applications
          </Link>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-100">
            Jobs
          </h2>
          <p className="text-xs text-slate-500">
            {runningCount} running · {jobs.length - runningCount} finished
          </p>
        </div>
        <button
          type="button"
          disabled={runningCount === 0 || cancellingAll}
          onClick={() => setConfirmOpen(true)}
          className="rounded border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Cancel all running jobs{runningCount > 0 ? ` (${runningCount})` : ""}
        </button>
      </div>

      <div className="overflow-hidden rounded border border-slate-800">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="w-28 px-3 py-2">Job</th>
              <th className="w-44 px-3 py-2">Kind</th>
              <th className="w-32 px-3 py-2">Started</th>
              <th className="w-24 px-3 py-2">Duration</th>
              <th className="w-28 px-3 py-2">Status</th>
              <th className="w-16 px-3 py-2">Exit</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {jobs.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-xs text-slate-500"
                >
                  No jobs.
                </td>
              </tr>
            )}
            {jobs.map((j) => (
              <tr key={j.jobId} className="hover:bg-slate-900/40">
                <td className="px-3 py-2 font-mono text-xs text-slate-300">
                  {j.jobId.slice(0, 8)}…
                </td>
                <td className="px-3 py-2 text-slate-200">{j.kind}</td>
                <td
                  className="px-3 py-2 text-xs text-slate-400"
                  title={j.startedAt}
                >
                  {formatRelative(j.startedAt, now)}
                </td>
                <td className="px-3 py-2 font-mono text-xs tabular-nums text-slate-300">
                  {j.status === "running"
                    ? formatDuration(now - Date.parse(j.startedAt))
                    : j.durationMs !== null
                      ? formatDuration(j.durationMs)
                      : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusChip status={j.status} />
                </td>
                <td className="px-3 py-2 font-mono text-xs tabular-nums text-slate-400">
                  {j.exitCode === null ? "—" : j.exitCode}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleViewLog(j)}
                      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      View log
                    </button>
                    {j.status === "running" && (
                      <button
                        type="button"
                        onClick={() => void handleCancel(j.jobId)}
                        className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded border border-slate-700 bg-slate-900 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-100">
              Cancel all running jobs?
            </h3>
            <p className="mt-2 text-xs text-slate-400">
              Sends SIGTERM to {runningCount} child process
              {runningCount === 1 ? "" : "es"}, with SIGKILL after a 5s grace
              window. Active SSE log streams will close.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={cancellingAll}
                className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                Keep running
              </button>
              <button
                type="button"
                onClick={() => void handleCancelAll()}
                disabled={cancellingAll}
                className="rounded border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
              >
                {cancellingAll ? "Cancelling…" : "Cancel all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const palette: Record<string, string> = {
    running: "border-sky-500/40 bg-sky-500/10 text-sky-300",
    completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    failed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    cancelled: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  };
  const cls = palette[status] ?? "border-slate-700 bg-slate-900 text-slate-300";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${cls}`}>
      {status}
    </span>
  );
}
