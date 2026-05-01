import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import type {
  JobDoneEvent,
  JobKind,
  JobLogEvent,
  JobRecord,
  JobStatus,
  PersistedJob,
} from "@job-seeker/shared";

const RING_BUFFER_MAX = 1000;
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const PERSIST_MAX = 50;

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

  serializeForPersist(): PersistedJob[] {
    const finished: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.finishedAtMs !== null) {
        finished.push(job);
      }
    }
    finished.sort(
      (a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0),
    );
    return finished.slice(0, PERSIST_MAX).map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      startedAt: job.startedAt,
      startedAtMs: job.startedAtMs,
      finishedAtMs: job.finishedAtMs,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      nextLineId: job.nextLineId,
      ring: [...job.ring],
    }));
  }

  loadPersisted(persisted: PersistedJob[]): number {
    let loaded = 0;
    for (const p of persisted) {
      if (this.jobs.has(p.jobId)) continue;
      if (p.status === "running") continue; // never restore "running" — children are gone
      const emitter = new EventEmitter();
      emitter.setMaxListeners(50);
      this.jobs.set(p.jobId, {
        jobId: p.jobId,
        kind: p.kind,
        startedAt: p.startedAt,
        startedAtMs: p.startedAtMs,
        finishedAtMs: p.finishedAtMs,
        status: p.status,
        exitCode: p.exitCode,
        signal: p.signal,
        child: null,
        ring: [...p.ring],
        nextLineId: p.nextLineId,
        emitter,
        cancelTimer: null,
      });
      loaded++;
    }
    return loaded;
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
  const finishedAt =
    job.finishedAtMs !== null ? new Date(job.finishedAtMs).toISOString() : null;
  const durationMs =
    job.finishedAtMs !== null ? job.finishedAtMs - job.startedAtMs : null;
  return {
    jobId: job.jobId,
    kind: job.kind,
    startedAt: job.startedAt,
    finishedAt,
    durationMs,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
  };
}
