import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import type {
  JobDoneEvent,
  JobKind,
  JobLogEvent,
  JobRecord,
  JobStatus,
} from "@job-seeker/shared";

const RING_BUFFER_MAX = 1000;
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export type Job = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
  child: ChildProcess | null;
  ring: JobLogEvent[];
  nextLineId: number;
  emitter: EventEmitter;
  cancelTimer: NodeJS.Timeout | null;
};

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.evictOld(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  create(jobId: string, kind: JobKind): Job {
    const now = new Date();
    const job: Job = {
      jobId,
      kind,
      startedAt: now.toISOString(),
      startedAtMs: now.getTime(),
      finishedAtMs: null,
      status: "running",
      exitCode: null,
      signal: null,
      child: null,
      ring: [],
      nextLineId: 1,
      emitter: new EventEmitter(),
      cancelTimer: null,
    };
    job.emitter.setMaxListeners(50);
    this.jobs.set(jobId, job);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(): JobRecord[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map(toRecord);
  }

  pushLine(job: Job, stream: "stdout" | "stderr", line: string): JobLogEvent {
    const ev: JobLogEvent = {
      id: job.nextLineId++,
      ts: new Date().toISOString(),
      stream,
      line,
    };
    job.ring.push(ev);
    if (job.ring.length > RING_BUFFER_MAX) {
      job.ring.splice(0, job.ring.length - RING_BUFFER_MAX);
    }
    job.emitter.emit("line", ev);
    return ev;
  }

  finish(
    job: Job,
    code: number | null,
    signal: string | null,
    statusOverride?: JobStatus,
  ): void {
    if (job.status !== "running") return;
    if (job.cancelTimer) {
      clearTimeout(job.cancelTimer);
      job.cancelTimer = null;
    }
    job.finishedAtMs = Date.now();
    job.exitCode = code;
    job.signal = signal;
    job.status =
      statusOverride ??
      (signal
        ? "cancelled"
        : code === 0
          ? "completed"
          : code === null
            ? "failed"
            : "failed");
    const done: JobDoneEvent = {
      code,
      signal,
      status: job.status,
    };
    job.emitter.emit("done", done);
  }

  private evictOld(): void {
    const cutoff = Date.now() - COMPLETED_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (
        job.status !== "running" &&
        job.finishedAtMs !== null &&
        job.finishedAtMs < cutoff
      ) {
        job.emitter.removeAllListeners();
        this.jobs.delete(id);
      }
    }
  }
}

export function toRecord(job: Job): JobRecord {
  return {
    jobId: job.jobId,
    kind: job.kind,
    startedAt: job.startedAt,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
  };
}
