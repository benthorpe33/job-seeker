import { test } from "node:test";
import { strict as assert } from "node:assert";

import { JobRegistry } from "../jobs/registry.js";
import { cancelJob, spawnJob } from "../jobs/runner.js";

function waitForDone(job: { emitter: import("node:events").EventEmitter }, timeoutMs = 5000): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for job done")), timeoutMs);
    job.emitter.once("done", (ev: { code: number | null; signal: string | null }) => {
      clearTimeout(t);
      resolve(ev);
    });
  });
}

test("spawnJob streams stdout lines and finishes with code 0", async () => {
  const registry = new JobRegistry();
  const job = spawnJob({
    kind: "scan",
    cmd: process.execPath,
    args: ["-e", "console.log('hello'); console.log('world'); process.exit(0)"],
    cwd: process.cwd(),
    registry,
  });
  const done = await waitForDone(job);
  assert.equal(done.code, 0);
  assert.equal(done.signal, null);
  const stdoutLines = job.ring.filter((e) => e.stream === "stdout").map((e) => e.line);
  assert.deepEqual(stdoutLines, ["hello", "world"]);
  assert.equal(job.status, "completed");
  // monotonic ids starting at 1
  assert.equal(job.ring[0]?.id, 1);
});

test("spawnJob captures stderr separately", async () => {
  const registry = new JobRegistry();
  const job = spawnJob({
    kind: "scan",
    cmd: process.execPath,
    args: ["-e", "console.error('boom'); process.exit(2)"],
    cwd: process.cwd(),
    registry,
  });
  const done = await waitForDone(job);
  assert.equal(done.code, 2);
  assert.equal(job.status, "failed");
  const stderrLines = job.ring.filter((e) => e.stream === "stderr").map((e) => e.line);
  assert.deepEqual(stderrLines, ["boom"]);
});

test("cancelJob terminates a long-running child", async () => {
  const registry = new JobRegistry();
  const job = spawnJob({
    kind: "scan",
    cmd: process.execPath,
    args: ["-e", "setInterval(() => console.log('tick'), 100)"],
    cwd: process.cwd(),
    registry,
  });
  // Let it produce at least one line.
  await new Promise((r) => setTimeout(r, 300));
  const ok = cancelJob(job);
  assert.equal(ok, true);
  const done = await waitForDone(job, 8000);
  assert.equal(job.status, "cancelled");
  assert.ok(done.signal !== null || done.code !== 0);
});

test("ring buffer retains only the last 1000 lines", async () => {
  const registry = new JobRegistry();
  const job = spawnJob({
    kind: "scan",
    cmd: process.execPath,
    args: [
      "-e",
      "for (let i = 0; i < 1500; i++) console.log('L' + i);",
    ],
    cwd: process.cwd(),
    registry,
  });
  await waitForDone(job);
  assert.equal(job.ring.length, 1000);
  // the very first id retained should be 501 (because we kept the last 1000 of 1500)
  assert.equal(job.ring[0]?.id, 501);
  assert.equal(job.ring[job.ring.length - 1]?.id, 1500);
});
