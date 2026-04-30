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

test("pipeline runs all 6 stages on the happy path", async () => {
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
    assert.deepEqual(completed, [1, 2, 3, 4, 5, 6]);
    for (const stage of snap.stages) {
      assert.equal(stage.status, "completed", `stage ${stage.stageNum}`);
      assert.equal(stage.exitCode, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline marks stage 3 skipped when prefetchJds=false", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-skip3-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, root, makeFactory({})), false);
    await p.run(1);
    const snap = p.snapshot();
    assert.equal(snap.status, "completed");
    const stage3 = snap.stages.find((s) => s.stageNum === 3)!;
    assert.equal(stage3.status, "skipped");
    assert.equal(stage3.jobId, null);
    for (const num of [1, 2, 4, 5, 6]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "completed", `stage ${num} should complete`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline halts and skips remaining when stage 4 fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-fail4-"));
  const registry = new JobRegistry();
  try {
    const p = new LinkedinPipeline(
      buildOpts(registry, root, makeFactory({ 4: "fail" })),
      true,
    );
    await p.run(1);
    const snap = p.snapshot();
    assert.equal(snap.status, "failed");
    assert.equal(snap.failedAtStage, 4);
    for (const num of [1, 2, 3]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "completed", `stage ${num} should complete`);
    }
    const stage4 = snap.stages.find((x) => x.stageNum === 4)!;
    assert.equal(stage4.status, "failed");
    assert.equal(stage4.exitCode, 7);
    assert.match(
      stage4.errorMessage ?? "",
      /simulated failure|exit 7/,
      "error message should surface child stderr or exit code",
    );
    for (const num of [5, 6]) {
      const s = snap.stages.find((x) => x.stageNum === num)!;
      assert.equal(s.status, "skipped", `stage ${num} should be skipped`);
      assert.equal(s.jobId, null, `stage ${num} should have no jobId`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline resume re-runs only stage 4+ without respawning earlier stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "js-pipeline-resume-"));
  const registry = new JobRegistry();
  try {
    // First run: stage 4 fails. Use a mutable behaviors box so we can flip
    // stage 4 to ok before resume without rebuilding the pipeline.
    const behaviors: Behaviors = { 4: "fail" };
    const factory: StageCommandFactory = (def) => {
      const inner = makeFactory(behaviors)(def);
      return inner;
    };
    const p = new LinkedinPipeline(buildOpts(registry, root, factory), true);
    await p.run(1);
    let snap = p.snapshot();
    assert.equal(snap.status, "failed");
    assert.equal(snap.failedAtStage, 4);

    const stage1JobId = snap.stages.find((s) => s.stageNum === 1)!.jobId;
    const stage2JobId = snap.stages.find((s) => s.stageNum === 2)!.jobId;
    assert.ok(stage1JobId);
    assert.ok(stage2JobId);

    // Flip stage 4 to ok and resume.
    behaviors[4] = "ok";
    await p.run(4);
    snap = p.snapshot();
    assert.equal(snap.status, "completed");
    assert.equal(snap.failedAtStage, null);

    assert.equal(
      snap.stages.find((s) => s.stageNum === 1)!.jobId,
      stage1JobId,
      "stage 1 should not have been respawned",
    );
    assert.equal(
      snap.stages.find((s) => s.stageNum === 2)!.jobId,
      stage2JobId,
      "stage 2 should not have been respawned",
    );

    const stage4 = snap.stages.find((s) => s.stageNum === 4)!;
    assert.equal(stage4.status, "completed");
    assert.ok(stage4.jobId);
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

    const stage3Events = log.filter((e) => e.num === 3);
    assert.equal(stage3Events.length, 1);
    assert.equal(stage3Events[0]!.type, "stage:done");
    assert.equal(stage3Events[0]!.status, "skipped");

    for (const num of [1, 2, 4, 5, 6]) {
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
    const stage3First = p.snapshot().stages.find((s) => s.stageNum === 3)!;
    assert.equal(stage3First.status, "skipped");

    await p.run(1);
    const stage3Second = p.snapshot().stages.find((s) => s.stageNum === 3)!;
    assert.equal(stage3Second.status, "skipped", "skipped sticks across runs");
    assert.equal(stage3Second.jobId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
