import { test } from "node:test";
import { strict as assert } from "node:assert";

import Fastify, { type FastifyInstance } from "fastify";

import type {
  CancelAllResponse,
  JobListResponse,
  JobLogEvent,
  JobLogResponse,
  JobStatus,
} from "@job-seeker/shared";

import { JobRegistry } from "../jobs/registry.js";
import { jobsPlugin } from "../jobs/routes.js";

async function buildJobsApp(): Promise<{
  app: FastifyInstance;
  registry: JobRegistry;
  close: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });
  const registry = new JobRegistry();
  app.decorate("jobs", registry);
  app.decorate("jobsBashPath", null);
  await app.register(jobsPlugin);
  await app.ready();
  return {
    app,
    registry,
    close: async () => {
      await app.close();
    },
  };
}

function seedJob(
  registry: JobRegistry,
  jobId: string,
  lines: ReadonlyArray<{ stream: "stdout" | "stderr"; line: string }>,
  finalStatus: JobStatus | null = "completed",
  exitCode: number | null = 0,
) {
  const job = registry.create(jobId, "scan");
  for (const { stream, line } of lines) {
    registry.pushLine(job, stream, line);
  }
  if (finalStatus !== null) {
    registry.finish(job, exitCode, null, finalStatus);
  }
  return job;
}

test("GET /api/jobs/:jobId/log returns full ring buffer", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    seedJob(registry, "job-happy", [
      { stream: "stdout", line: "alpha" },
      { stream: "stderr", line: "warn" },
      { stream: "stdout", line: "omega" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/job-happy/log",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobLogResponse;
    assert.equal(body.jobId, "job-happy");
    assert.equal(body.kind, "scan");
    assert.equal(body.status, "completed");
    assert.equal(body.exitCode, 0);
    assert.equal(body.ringSize, 3);
    assert.equal(body.ringTruncated, false);
    assert.equal(body.events.length, 3);
    assert.deepEqual(
      body.events.map((e: JobLogEvent) => e.line),
      ["alpha", "warn", "omega"],
    );
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/log?tail=2 returns only the last two events", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    seedJob(registry, "job-tail", [
      { stream: "stdout", line: "one" },
      { stream: "stdout", line: "two" },
      { stream: "stdout", line: "three" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/job-tail/log?tail=2",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobLogResponse;
    assert.equal(body.events.length, 2);
    assert.deepEqual(
      body.events.map((e: JobLogEvent) => e.line),
      ["two", "three"],
    );
    // ringSize reflects the underlying ring, not the filtered slice.
    assert.equal(body.ringSize, 3);
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/log?stream=stderr filters to stderr only", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    seedJob(registry, "job-stream", [
      { stream: "stdout", line: "ok-1" },
      { stream: "stderr", line: "err-1" },
      { stream: "stdout", line: "ok-2" },
      { stream: "stderr", line: "err-2" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/job-stream/log?stream=stderr",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobLogResponse;
    assert.equal(body.events.length, 2);
    assert.ok(body.events.every((e: JobLogEvent) => e.stream === "stderr"));
    assert.deepEqual(
      body.events.map((e: JobLogEvent) => e.line),
      ["err-1", "err-2"],
    );
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/log returns 404 for unknown jobId", async () => {
  const { app, close } = await buildJobsApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/does-not-exist/log",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, "job not found");
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/log reports ringTruncated when head was evicted", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    const job = registry.create("job-trunc", "scan");
    // RING_BUFFER_MAX is 1000; push 1500 to force the front to be spliced.
    for (let i = 0; i < 1500; i++) {
      registry.pushLine(job, "stdout", `L${i}`);
    }
    registry.finish(job, 0, null, "completed");

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/job-trunc/log",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobLogResponse;
    assert.equal(body.ringSize, 1000);
    assert.equal(body.ringTruncated, true);
    assert.equal(body.events.length, 1000);
    // First retained event id should be 501 (1500 pushed, last 1000 kept).
    assert.equal(body.events[0]?.id, 501);
    assert.equal(body.events[body.events.length - 1]?.id, 1500);
  } finally {
    await close();
  }
});

test("GET /api/jobs?status=active returns only running jobs", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    const running = registry.create("job-running", "scan");
    registry.pushLine(running, "stdout", "still going");
    seedJob(registry, "job-done", [{ stream: "stdout", line: "x" }]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs?status=active",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobListResponse;
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0]!.jobId, "job-running");
    assert.equal(body.jobs[0]!.status, "running");
    assert.equal(body.jobs[0]!.durationMs, null);
    assert.equal(body.jobs[0]!.finishedAt, null);
  } finally {
    await close();
  }
});

test("GET /api/jobs?status=completed returns only finished jobs with duration", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    registry.create("job-running", "scan");
    seedJob(registry, "job-done", [{ stream: "stdout", line: "x" }]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs?status=completed",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as JobListResponse;
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0]!.jobId, "job-done");
    assert.equal(body.jobs[0]!.status, "completed");
    assert.equal(typeof body.jobs[0]!.durationMs, "number");
    assert.notEqual(body.jobs[0]!.finishedAt, null);
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/logs returns text/plain dump of ring buffer", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    seedJob(registry, "job-text", [
      { stream: "stdout", line: "hello" },
      { stream: "stderr", line: "uh oh" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/job-text/logs",
    });
    assert.equal(res.statusCode, 200);
    assert.match(
      String(res.headers["content-type"]),
      /text\/plain/,
    );
    const lines = res.body.split("\n").filter((s) => s.length > 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /\[stdout\] hello$/);
    assert.match(lines[1]!, /\[stderr\] uh oh$/);
  } finally {
    await close();
  }
});

test("GET /api/jobs/:jobId/logs returns 404 for unknown jobId", async () => {
  const { app, close } = await buildJobsApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/missing/logs",
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await close();
  }
});

test("POST /api/jobs/cancel-all without confirm returns 400", async () => {
  const { app, close } = await buildJobsApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/cancel-all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});

test("POST /api/jobs/cancel-all SIGTERMs every running job's child", async () => {
  const { app, registry, close } = await buildJobsApp();
  try {
    const killCalls: Array<{ jobId: string; signal: string }> = [];
    function fakeChild(jobId: string) {
      return {
        kill: (signal: string) => {
          killCalls.push({ jobId, signal });
          return true;
        },
      };
    }
    const j1 = registry.create("running-1", "scan");
    j1.child = fakeChild("running-1") as any;
    const j2 = registry.create("running-2", "pdf");
    j2.child = fakeChild("running-2") as any;
    seedJob(registry, "done-1", [{ stream: "stdout", line: "x" }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/cancel-all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.statusCode, 202);
    const body = res.json() as CancelAllResponse;
    assert.equal(body.requested, 2);
    assert.deepEqual(body.jobIds.sort(), ["running-1", "running-2"]);
    assert.equal(killCalls.length, 2);
    assert.ok(killCalls.every((c) => c.signal === "SIGTERM"));
    // Clear cancel timers so the test exits cleanly.
    if (j1.cancelTimer) clearTimeout(j1.cancelTimer);
    if (j2.cancelTimer) clearTimeout(j2.cancelTimer);
  } finally {
    await close();
  }
});
