import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type {
  JobListResponse,
  JobStartRequest,
  JobStartResponse,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import { isJobKind, listJobKinds, resolveKind } from "./kinds.js";
import { JobRegistry } from "./registry.js";
import { cancelJob, detectBash, spawnJob } from "./runner.js";
import { streamJobLogs } from "./sse.js";

declare module "fastify" {
  interface FastifyInstance {
    jobs: JobRegistry;
    jobsBashPath: string | null;
  }
}

export const jobsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const registry = new JobRegistry();
  registry.startCleanup();
  const bashPath = detectBash();
  app.decorate("jobs", registry);
  app.decorate("jobsBashPath", bashPath);
  if (!bashPath) {
    app.log.warn(
      "bash not found on PATH; bash-based job kinds (batch, full-report) will be rejected with 503 until bash is available.",
    );
  } else {
    app.log.info(`bash resolved at ${bashPath}`);
  }

  app.addHook("onClose", async () => {
    registry.stopCleanup();
  });

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

  app.get("/api/jobs", async (): Promise<JobListResponse> => {
    return { jobs: registry.list() };
  });
};

export default jobsPlugin;
