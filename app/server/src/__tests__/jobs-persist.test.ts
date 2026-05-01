import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadJobsFile, saveJobsFile } from "../jobs/persistence.js";
import { JobRegistry } from "../jobs/registry.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jobs-persist-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

test("serializeForPersist skips running jobs and includes finished ones", () => {
  const reg = new JobRegistry();
  const running = reg.create("r", "scan");
  reg.pushLine(running, "stdout", "still going");
  const done = reg.create("d", "pdf");
  reg.pushLine(done, "stdout", "all done");
  reg.finish(done, 0, null);

  const out = reg.serializeForPersist();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.jobId, "d");
  assert.equal(out[0]!.status, "completed");
  assert.equal(out[0]!.ring.length, 1);
});

test("serializeForPersist caps at 50 newest by finishedAtMs", () => {
  const reg = new JobRegistry();
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    const job = reg.create(`job-${i}`, "scan");
    reg.finish(job, 0, null);
    // Backdate finishedAtMs so we have a deterministic ordering.
    job.finishedAtMs = now - (60 - i) * 1000;
  }
  const out = reg.serializeForPersist();
  assert.equal(out.length, 50);
  // Newest first: job-59 should be at the head, job-10 at the tail.
  assert.equal(out[0]!.jobId, "job-59");
  assert.equal(out[out.length - 1]!.jobId, "job-10");
});

test("loadPersisted round-trips via serializeForPersist + ring buffer survives", () => {
  const a = new JobRegistry();
  const job = a.create("hello", "pdf");
  a.pushLine(job, "stdout", "line one");
  a.pushLine(job, "stderr", "line two");
  a.finish(job, 0, null);
  const snapshot = a.serializeForPersist();

  const b = new JobRegistry();
  const loaded = b.loadPersisted(snapshot);
  assert.equal(loaded, 1);
  const restored = b.get("hello");
  assert.ok(restored);
  assert.equal(restored!.kind, "pdf");
  assert.equal(restored!.status, "completed");
  assert.equal(restored!.ring.length, 2);
  assert.equal(restored!.ring[0]!.line, "line one");
  assert.equal(restored!.ring[1]!.line, "line two");
});

test("loadPersisted skips entries with status=running and existing ids", () => {
  const reg = new JobRegistry();
  const real = reg.create("dup", "scan");
  reg.finish(real, 0, null);

  const loaded = reg.loadPersisted([
    {
      jobId: "ghost-running",
      kind: "scan",
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      finishedAtMs: null,
      status: "running",
      exitCode: null,
      signal: null,
      nextLineId: 1,
      ring: [],
    },
    {
      jobId: "dup",
      kind: "scan",
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      status: "completed",
      exitCode: 0,
      signal: null,
      nextLineId: 1,
      ring: [],
    },
  ]);
  assert.equal(loaded, 0);
});

test("saveJobsFile + loadJobsFile round-trip via temp file", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const file = join(dir, "jobs.json");
    const reg = new JobRegistry();
    const job = reg.create("disk-test", "scan");
    reg.pushLine(job, "stdout", "persisted line");
    reg.finish(job, 0, null);

    await saveJobsFile(file, reg.serializeForPersist());
    const loaded = await loadJobsFile(file);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.jobId, "disk-test");
    assert.equal(loaded[0]!.ring[0]!.line, "persisted line");
  } finally {
    cleanup();
  }
});

test("loadJobsFile returns [] for missing file", async () => {
  const out = await loadJobsFile(join(tmpdir(), "definitely-not-a-real-file.json"));
  assert.deepEqual(out, []);
});

test("loadJobsFile returns [] for malformed JSON", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const file = join(dir, "jobs.json");
    await writeFile(file, "{not json", "utf-8");
    const out = await loadJobsFile(file);
    assert.deepEqual(out, []);
  } finally {
    cleanup();
  }
});
