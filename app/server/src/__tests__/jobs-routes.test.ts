import { test } from "node:test";
import { strict as assert } from "node:assert";

import Fastify, { type FastifyInstance } from "fastify";

import type {
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
