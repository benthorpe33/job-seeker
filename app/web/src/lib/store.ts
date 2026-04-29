import { create } from "zustand";

import type { JobKind, JobStatus } from "@job-seeker/shared";

export type JobLogLine = {
  id: number;
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type ActiveJob = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
  status: JobStatus;
  lines: JobLogLine[];
  exitCode?: number | null;
};

type JobState = {
  activeJobs: Map<string, ActiveJob>;
  panelOpen: boolean;
  visibleJobId: string | null;
  registerJob: (job: { jobId: string; kind: JobKind; startedAt: string }) => void;
  appendLine: (jobId: string, line: JobLogLine) => void;
  finishJob: (jobId: string, status: JobStatus, exitCode: number | null) => void;
  removeJob: (jobId: string) => void;
  openPanel: (jobId?: string | null) => void;
  closePanel: () => void;
};

export const useJobStore = create<JobState>((set) => ({
  activeJobs: new Map(),
  panelOpen: false,
  visibleJobId: null,
  registerJob: (job) =>
    set((state) => {
      const next = new Map(state.activeJobs);
      next.set(job.jobId, {
        jobId: job.jobId,
        kind: job.kind,
        startedAt: job.startedAt,
        status: "running",
        lines: [],
      });
      return { activeJobs: next, panelOpen: true, visibleJobId: job.jobId };
    }),
  appendLine: (jobId, line) =>
    set((state) => {
      const cur = state.activeJobs.get(jobId);
      if (!cur) return {};
      // Skip duplicates by id (replay-on-reconnect dedupe).
      if (cur.lines.length > 0 && cur.lines[cur.lines.length - 1]!.id >= line.id) {
        if (cur.lines.some((l) => l.id === line.id)) return {};
      }
      const next = new Map(state.activeJobs);
      next.set(jobId, { ...cur, lines: [...cur.lines, line] });
      return { activeJobs: next };
    }),
  finishJob: (jobId, status, exitCode) =>
    set((state) => {
      const cur = state.activeJobs.get(jobId);
      if (!cur) return {};
      const next = new Map(state.activeJobs);
      next.set(jobId, { ...cur, status, exitCode });
      return { activeJobs: next };
    }),
  removeJob: (jobId) =>
    set((state) => {
      const next = new Map(state.activeJobs);
      next.delete(jobId);
      return {
        activeJobs: next,
        visibleJobId: state.visibleJobId === jobId ? null : state.visibleJobId,
      };
    }),
  openPanel: (jobId) =>
    set((state) => ({
      panelOpen: true,
      visibleJobId: jobId !== undefined ? jobId : state.visibleJobId,
    })),
  closePanel: () => set({ panelOpen: false }),
}));
