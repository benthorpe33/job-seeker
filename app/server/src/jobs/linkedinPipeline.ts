import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type {
  JobDoneEvent,
  JobKind,
  PipelineEvent,
  PipelineRecord,
  PipelineStage,
  PipelineStageStatus,
} from "@job-seeker/shared";

import { resolveKind } from "./kinds.js";
import type { Job, JobRegistry } from "./registry.js";
import { spawnJob } from "./runner.js";

export type ResolvedStageCommand = {
  cmd: string;
  args: string[];
};

export type StageCommandFactory = (def: StageDef) =>
  | { ok: true; resolved: ResolvedStageCommand }
  | { ok: false; message: string };

// In-memory only. A server restart mid-pipeline drops state and Ben has to
// re-click Start. Persisting to disk is doable in v2 but adds correctness
// surface (atomic writes, race with running children) we don't need yet.

export type StageDef = {
  stageNum: number;
  name: string;
  kind: JobKind;
  args: string[];
};

export const STAGE_DEFS_BASE: ReadonlyArray<StageDef> = [
  {
    stageNum: 1,
    name: "Pull saved jobs from LinkedIn",
    kind: "linkedin-saved-jobs",
    args: ["--auto"],
  },
  {
    stageNum: 2,
    name: "Resolve ATS URLs (slow: ~3-5s/job)",
    kind: "resolve-ats-urls",
    args: [],
  },
  {
    stageNum: 3,
    name: "Append resolved postings to pipeline.md",
    kind: "append-to-pipeline",
    args: ["--yes"],
  },
  {
    stageNum: 4,
    name: "Build batch input from pipeline",
    kind: "linkedin-build-input",
    args: [],
  },
  {
    stageNum: 5,
    name: "Filter already-tracked + non-target-location URLs",
    kind: "filter-batch-input",
    args: [],
  },
  {
    stageNum: 6,
    name: "Pre-fetch JDs (Greenhouse/Ashby)",
    kind: "prefetch-jds",
    args: [],
  },
  {
    stageNum: 7,
    name: "Run batch evaluations",
    kind: "batch",
    args: ["--parallel", "2"],
  },
  {
    stageNum: 8,
    name: "Merge tracker additions",
    kind: "merge-tracker",
    args: [],
  },
  {
    stageNum: 9,
    name: "Verify pipeline integrity",
    kind: "verify-pipeline",
    args: [],
  },
];

function makePendingStage(def: StageDef): PipelineStage {
  return {
    stageNum: def.stageNum,
    name: def.name,
    kind: def.kind,
    status: "pending",
    jobId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    errorMessage: null,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export type PipelineRunnerOpts = {
  registry: JobRegistry;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  bashAvailable: boolean;
  bashPath: string | null;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
  // Tests inject a synthetic factory so each stage spawns a controlled child
  // (e.g. `node -e ...`) instead of the real script. Production callers leave
  // this undefined and the default resolveKind + bash path is used.
  commandFactory?: StageCommandFactory;
};

export class LinkedinPipeline {
  readonly pipelineId: string;
  readonly emitter = new EventEmitter();
  private record: PipelineRecord;
  private readonly opts: PipelineRunnerOpts;
  private active: Job | null = null;

  constructor(opts: PipelineRunnerOpts, prefetchJds: boolean) {
    this.opts = opts;
    this.pipelineId = randomUUID();
    const stages = STAGE_DEFS_BASE.map((d) => makePendingStage(d));
    if (!prefetchJds) {
      const prefetchStage = stages.find((s) => s.kind === "prefetch-jds");
      if (prefetchStage) {
        prefetchStage.status = "skipped";
        prefetchStage.errorMessage = "skipped: prefetchJds=false";
      }
    }
    this.record = {
      pipelineId: this.pipelineId,
      startedAt: nowIso(),
      finishedAt: null,
      status: "running",
      failedAtStage: null,
      prefetchJds,
      stages,
    };
    this.emitter.setMaxListeners(50);
  }

  snapshot(): PipelineRecord {
    return JSON.parse(JSON.stringify(this.record)) as PipelineRecord;
  }

  private emit(ev: PipelineEvent): void {
    this.emitter.emit("event", ev);
  }

  /**
   * Run from `fromStage` (inclusive) through stage 9. Earlier stages are
   * preserved as-is; later stages reset to pending unless they're already
   * skipped (prefetchJds=false sticks).
   */
  async run(fromStage: number): Promise<PipelineRecord> {
    for (const stage of this.record.stages) {
      if (stage.stageNum < fromStage) continue;
      if (stage.status === "skipped") continue;
      stage.status = "pending";
      stage.jobId = null;
      stage.startedAt = null;
      stage.finishedAt = null;
      stage.exitCode = null;
      stage.errorMessage = null;
    }
    this.record.status = "running";
    this.record.failedAtStage = null;
    this.record.finishedAt = null;

    let halted = false;
    for (const stage of this.record.stages) {
      if (stage.stageNum < fromStage) continue;
      if (halted) {
        if (stage.status === "skipped") continue;
        stage.status = "skipped";
        stage.errorMessage = `skipped: pipeline halted at stage ${this.record.failedAtStage}`;
        this.emit({ type: "stage:done", stage: { ...stage } });
        continue;
      }
      if (stage.status === "skipped") {
        // Already-skipped (prefetchJds=false): emit a synthesized done so the
        // UI's stepper updates without us spawning anything.
        this.emit({ type: "stage:done", stage: { ...stage } });
        continue;
      }
      const ok = await this.runStage(stage);
      if (!ok) {
        halted = true;
        this.record.failedAtStage = stage.stageNum;
      }
    }

    this.record.finishedAt = nowIso();
    this.record.status = halted ? "failed" : "completed";
    this.emit({ type: "pipeline:done", pipeline: this.snapshot() });
    return this.snapshot();
  }

  cancel(): boolean {
    if (this.active && this.active.status === "running" && this.active.child) {
      try {
        this.active.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      return true;
    }
    return false;
  }

  private async runStage(stage: PipelineStage): Promise<boolean> {
    if (stage.kind === null) return false;
    const def = STAGE_DEFS_BASE.find((d) => d.stageNum === stage.stageNum);
    if (!def) {
      stage.status = "failed";
      stage.errorMessage = `internal: no StageDef for stage ${stage.stageNum}`;
      this.emit({ type: "stage:done", stage: { ...stage } });
      return false;
    }
    let cmd: string;
    let args: string[];
    if (this.opts.commandFactory) {
      const r = this.opts.commandFactory(def);
      if (!r.ok) {
        stage.status = "failed";
        stage.errorMessage = r.message;
        stage.startedAt = nowIso();
        stage.finishedAt = stage.startedAt;
        this.emit({ type: "stage:start", stage: { ...stage } });
        this.emit({ type: "stage:done", stage: { ...stage } });
        return false;
      }
      cmd = r.resolved.cmd;
      args = r.resolved.args;
    } else {
      const resolved = resolveKind(def.kind, def.args, this.opts.bashAvailable);
      if ("ok" in resolved) {
        stage.status = "failed";
        stage.errorMessage = resolved.message;
        stage.startedAt = nowIso();
        stage.finishedAt = stage.startedAt;
        this.emit({ type: "stage:start", stage: { ...stage } });
        this.emit({ type: "stage:done", stage: { ...stage } });
        return false;
      }
      cmd =
        resolved.needsBash && this.opts.bashPath ? this.opts.bashPath : resolved.cmd;
      args = resolved.args;
    }
    const job = spawnJob({
      kind: def.kind,
      cmd,
      args,
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      registry: this.opts.registry,
    });
    this.active = job;
    stage.status = "running";
    stage.jobId = job.jobId;
    stage.startedAt = nowIso();
    this.emit({ type: "stage:start", stage: { ...stage } });

    const done: JobDoneEvent = await new Promise((resolve) => {
      job.emitter.once("done", (ev: JobDoneEvent) => resolve(ev));
    });
    this.active = null;
    stage.finishedAt = nowIso();
    stage.exitCode = done.code;
    if (done.status === "completed" && done.code === 0) {
      stage.status = "completed";
      this.emit({ type: "stage:done", stage: { ...stage } });
      return true;
    }
    stage.status = "failed";
    const tail = job.ring
      .filter((e) => e.stream === "stderr")
      .slice(-3)
      .map((e) => e.line)
      .join(" | ");
    stage.errorMessage = tail
      ? `${done.status} (exit ${done.code}): ${tail}`
      : `${done.status} (exit ${done.code})`;
    this.emit({ type: "stage:done", stage: { ...stage } });
    return false;
  }
}

export class PipelineStore {
  private readonly map = new Map<string, LinkedinPipeline>();

  add(p: LinkedinPipeline): void {
    this.map.set(p.pipelineId, p);
  }
  get(id: string): LinkedinPipeline | undefined {
    return this.map.get(id);
  }
  list(): PipelineRecord[] {
    return Array.from(this.map.values()).map((p) => p.snapshot());
  }
}

/** Convenience: which stage to resume from given the current record. The
 * lowest-numbered failed stage. Skipped stages are preserved as-is. */
export function resumeFromStage(record: PipelineRecord): number | null {
  const failed = record.stages.find((s) => s.status === "failed");
  return failed ? failed.stageNum : null;
}
