import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LinkedinPipeline,
  type PipelineRunnerOpts,
  type StageCommandFactory,
} from "../jobs/linkedinPipeline.js";
import { JobRegistry } from "../jobs/registry.js";

type StageBehavior = "ok" | "fail";
type Behaviors = Partial<Record<number, StageBehavior>>;

function makeFactory(behaviors: Behaviors): StageCommandFactory {
  return (def) => {
    const behavior: StageBehavior = behaviors[def.stageNum] ?? "ok";
    const code = behavior === "ok" ? 0 : 7;
    const script = [
      `console.log('[stage ${def.stageNum}] ${behavior}');`,
      behavior === "fail"
        ? `console.error('[stage ${def.stageNum}] simulated failure');`
        : "",
      `process.exit(${code});`,
    ].join("");
    return {
      ok: true,
      resolved: { cmd: process.execPath, args: ["-e", script] },
    };
  };
}

function buildOpts(
  registry: JobRegistry,
  root: string,
  factory: StageCommandFactory,
): PipelineRunnerOpts {
  return {
    registry,
    cwd: root,
    env: process.env,
    bashAvailable: true,
    bashPath: "/bin/bash",
    commandFactory: factory,
  };
}

test("pipeline runs all 9 stages on the happy path", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, root, makeFactory({})), true);
    const completed: number[] = [];
    p.emitter.on("event", (ev) => {
      if (ev.type === "stage:done" && ev.stage.status === "completed") {
        completed.push(ev.stage.stageNum);
      }
    });
    await p.run(1);
    const snap = p.snapshot();
    assert.equal(snap.status, "completed");
    assert.equal(snap.failedAtStage, null);
    assert.deepEqual(completed, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const stage of snap.stages) {
      assert.equal(stage.status, "completed", `stage ${stage.stageNum}`);
      assert.equal(stage.exitCode, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline marks stage 6 (prefetch-jds) skipped when prefetchJds=false", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-skip6-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, root, makeFactory({})), false);
    await p.run(1);
    const snap = p.snapshot();
    assert.equal(snap.status, "completed");
    const prefetchStage = snap.stages.find((s) => s.kind === "prefetch-jds")!;
    assert.equal(prefetchStage.stageNum, 6);
    assert.equal(prefetchStage.status, "skipped");
    assert.equal(prefetchStage.jobId, null);
    for (const num of [1, 2, 3, 4, 5, 7, 8, 9]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "completed", `stage ${num} should complete`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline halts and skips remaining when stage 7 (batch) fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-fail7-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(
      buildOpts(registry, root, makeFactory({ 7: "fail" })),
      true,
    );
    await p.run(1);
    const snap = p.snapshot();
    assert.equal(snap.status, "failed");
    assert.equal(snap.failedAtStage, 7);
    for (const num of [1, 2, 3, 4, 5, 6]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "completed", `stage ${num} should complete`);
    }
    const stage7 = snap.stages.find((x) => x.stageNum === 7)!;
    assert.equal(stage7.status, "failed");
    assert.equal(stage7.exitCode, 7);
    assert.match(
      stage7.errorMessage ?? "",
      /simulated failure|exit 7/,
      "error message should surface child stderr or exit code",
    );
    for (const num of [8, 9]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "skipped", `stage ${num} should be skipped`);
      assert.equal(s.jobId, null, `stage ${num} should have no jobId`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline resume re-runs only stage 7+ without respawning earlier stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-resume-"));
  const registry = new JobRegistry();
  try {
    // First run: stage 7 (batch) fails. Use a mutable behaviors box so we
    // can flip it to ok before resume without rebuilding the pipeline.
    const behaviors: Behaviors = { 7: "fail" };
    const factory: StageCommandFactory = (def) => {
      const inner = makeFactory(behaviors)(def);
      return inner;
    };
    const p = new LinkedinPipeline(buildOpts(registry, root, factory), true);
    await p.run(1);
    let snap = p.snapshot();
    assert.equal(snap.status, "failed");
    assert.equal(snap.failedAtStage, 7);

    const earlierJobIds = [1, 2, 3, 4, 5, 6].map(
      (n) => snap.stages.find((s) => s.stageNum === n)!.jobId,
    );
    for (const id of earlierJobIds) assert.ok(id);

    // Flip stage 7 to ok and resume.
    behaviors[7] = "ok";
    await p.run(7);
    snap = p.snapshot();
    assert.equal(snap.status, "completed");
    assert.equal(snap.failedAtStage, null);

    for (const [idx, num] of [1, 2, 3, 4, 5, 6].entries()) {
      assert.equal(
        snap.stages.find((s) => s.stageNum === num)!.jobId,
        earlierJobIds[idx],
        `stage ${num} should not have been respawned`,
      );
    }

    const stage7 = snap.stages.find((s) => s.stageNum === 7)!;
    assert.equal(stage7.status, "completed");
    assert.ok(stage7.jobId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline emits stage:start, stage:done, pipeline:done in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-events-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, root, makeFactory({})), false);
    type EvLog = { type: string; num?: number; status?: string };
    const log: EvLog[] = [];
    p.emitter.on("event", (ev) => {
      if (ev.type === "stage:start") {
        log.push({ type: ev.type, num: ev.stage.stageNum });
      } else if (ev.type === "stage:done") {
        log.push({
          type: ev.type,
          num: ev.stage.stageNum,
          status: ev.stage.status,
        });
      } else if (ev.type === "pipeline:done") {
        log.push({ type: ev.type, status: ev.pipeline.status });
      }
    });
    await p.run(1);

    assert.equal(log[log.length - 1]!.type, "pipeline:done");

    // prefetch-jds is now stage 6 — the skipped one when prefetchJds=false.
    const prefetchEvents = log.filter((e) => e.num === 6);
    assert.equal(prefetchEvents.length, 1);
    assert.equal(prefetchEvents[0]!.type, "stage:done");
    assert.equal(prefetchEvents[0]!.status, "skipped");

    for (const num of [1, 2, 3, 4, 5, 7, 8, 9]) {
      const startIdx = log.findIndex(
        (e) => e.type === "stage:start" && e.num === num,
      );
      const doneIdx = log.findIndex(
        (e) => e.type === "stage:done" && e.num === num,
      );
      assert.ok(startIdx >= 0, `start for stage ${num}`);
      assert.ok(doneIdx > startIdx, `done after start for stage ${num}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline resume from stage 1 reruns everything including previously-skipped stages? no — skipped stays skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-skipped-stays-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, root, makeFactory({})), false);
    await p.run(1);
    // prefetch-jds is now stage 6 — the one that's skipped when prefetchJds=false.
    const prefetchFirst = p.snapshot().stages.find((s) => s.stageNum === 6)!;
    assert.equal(prefetchFirst.status, "skipped");

    await p.run(1);
    const prefetchSecond = p.snapshot().stages.find((s) => s.stageNum === 6)!;
    assert.equal(prefetchSecond.status, "skipped", "skipped sticks across runs");
    assert.equal(prefetchSecond.jobId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
