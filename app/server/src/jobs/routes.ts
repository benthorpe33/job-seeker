import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type {
  CancelAllResponse,
  JobListResponse,
  JobLogResponse,
  JobsFilterStatus,
  JobStartRequest,
  JobStartResponse,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import { isJobKind, listJobKinds, resolveKind } from "./kinds.js";
import { JobRegistry } from "./registry.js";
import { cancelJob, spawnJob } from "./runner.js";
import { streamJobLogs } from "./sse.js";

declare module "fastify" {
  interface FastifyInstance {
    jobs: JobRegistry;
    jobsBashPath: string | null;
  }
}

// jobsPlugin only registers routes; the `jobs` and `jobsBashPath` decorators
// must be added to the root app in main.ts before any sibling plugin is
// registered. Decorating inside this plugin would scope them to its
// encapsulation context, hiding them from cvOrchestrator / linkedinPipeline /
// other API plugins registered as siblings.
export const jobsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const registry = app.jobs;
  const bashPath = app.jobsBashPath;

  app.post<{
    Params: { kind: string };
    Body: JobStartRequest;
    Reply: JobStartResponse | { error: string; allowed?: string[] };
  }>("/api/jobs/:kind/start", async (request, reply) => {
    const kind = request.params.kind;
    if (!isJobKind(kind)) {
      return reply
        .code(400)
        .send({ error: `Unknown job kind: ${kind}`, allowed: listJobKinds() });
    }
    const userArgs = Array.isArray(request.body?.args) ? request.body!.args! : [];
    const resolved = resolveKind(kind, userArgs, bashPath !== null);
    if ("ok" in resolved) {
      return reply.code(resolved.status).send({ error: resolved.message });
    }

    // For bash kinds, swap the resolved cmd to the absolute path we found at startup.
    const cmd = resolved.needsBash && bashPath ? bashPath : resolved.cmd;

    const job = spawnJob({
      kind,
      cmd,
      args: resolved.args,
      cwd: REPO_ROOT,
      env: process.env,
      registry,
    });

    return reply.code(200).send({
      jobId: job.jobId,
      kind: job.kind,
      startedAt: job.startedAt,
    });
  });

  app.get<{ Params: { jobId: string }; Querystring: { lastEventId?: string } }>(
    "/sse/jobs/:jobId",
    async (request, reply) => {
      const job = registry.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: "job not found" });
      }
      reply.hijack();
      streamJobLogs(request, reply, job);
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/cancel",
    async (request, reply) => {
      const job = registry.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: "job not found" });
      }
      if (job.status !== "running") {
        return reply.code(409).send({ error: `job is ${job.status}` });
      }
      cancelJob(job);
      return reply.code(202).send({ jobId: job.jobId, status: "cancelling" });
    },
  );

  app.get<{
    Querystring: { status?: JobsFilterStatus };
  }>("/api/jobs", async (request): Promise<JobListResponse> => {
    const filter = request.query.status;
    const all = registry.list();
    if (filter === "active") {
      return { jobs: all.filter((j) => j.status === "running") };
    }
    if (filter === "completed") {
      return { jobs: all.filter((j) => j.status !== "running") };
    }
    return { jobs: all };
  });

  app.post<{
    Body: { confirm?: boolean };
    Reply: CancelAllResponse | { error: string };
  }>("/api/jobs/cancel-all", async (request, reply) => {
    if (request.body?.confirm !== true) {
      return reply.code(400).send({ error: "confirm:true required" });
    }
    const jobIds: string[] = [];
    let isFirst = true;
    for (const rec of registry.list()) {
      if (rec.status !== "running") continue;
      const job = registry.get(rec.jobId);
      if (!job) continue;
      if (!isFirst) {
        await new Promise((r) => setTimeout(r, 100));
      }
      isFirst = false;
      cancelJob(job);
      jobIds.push(job.jobId);
    }
    return reply
      .code(202)
      .send({ requested: jobIds.length, jobIds });
  });

  app.get<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/logs",
    async (request, reply) => {
      const job = registry.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: "job not found" });
      }
      const lines = job.ring
        .map((e) => `${e.ts} [${e.stream}] ${e.line}`)
        .join("\n");
      reply
        .code(200)
        .header("Content-Type", "text/plain; charset=utf-8")
        .send(lines + (lines.length > 0 ? "\n" : ""));
    },
  );

  app.get<{
    Params: { jobId: string };
    Querystring: { tail?: string; stream?: "stdout" | "stderr" };
  }>("/api/jobs/:jobId/log", async (request, reply) => {
    const job = registry.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    let events = job.ring;
    if (
      request.query.stream === "stdout" ||
      request.query.stream === "stderr"
    ) {
      events = events.filter((e) => e.stream === request.query.stream);
    }

    const tailRaw = request.query.tail;
    if (tailRaw !== undefined) {
      const tail = Number.parseInt(tailRaw, 10);
      if (Number.isFinite(tail) && tail > 0) {
        events = events.slice(-tail);
      }
    }

    // nextLineId starts at 1 and increments per push; if the head id is still
    // 1 we never spliced, otherwise the ring lost lines off the front.
    const ringTruncated = (job.ring[0]?.id ?? 1) > 1;

    const body: JobLogResponse = {
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      exitCode: job.exitCode,
      ringSize: job.ring.length,
      ringTruncated,
      events,
    };
    return reply.code(200).send(body);
  });
};

export default jobsPlugin;
