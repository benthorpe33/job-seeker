import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type {
  PipelineEvent,
  PipelineStartRequest,
  PipelineStartResponse,
  PipelineRecord,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import {
  LinkedinPipeline,
  PipelineStore,
  resumeFromStage,
} from "../jobs/linkedinPipeline.js";

declare module "fastify" {
  interface FastifyInstance {
    linkedinPipelines: PipelineStore;
  }
}

function safeWrite(reply: FastifyReply, payload: string): boolean {
  if (reply.raw.writableEnded || reply.raw.destroyed) return false;
  try {
    return reply.raw.write(payload);
  } catch {
    return false;
  }
}

export const linkedinPipelinePlugin: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  if (!app.hasDecorator("linkedinPipelines")) {
    app.decorate("linkedinPipelines", new PipelineStore());
  }

  app.post<{
    Body: PipelineStartRequest;
    Reply: PipelineStartResponse | { error: string };
  }>("/api/jobs/linkedin/start", async (request, reply) => {
    const prefetchJds = request.body?.prefetchJds === true;
    const pipeline = new LinkedinPipeline(
      {
        registry: app.jobs,
        cwd: REPO_ROOT,
        env: process.env,
        bashAvailable: app.jobsBashPath !== null,
        bashPath: app.jobsBashPath,
        log: {
          info: (m) => app.log.info(m),
          warn: (m) => app.log.warn(m),
          error: (m, e) => app.log.error({ err: e }, m),
        },
      },
      prefetchJds,
    );
    app.linkedinPipelines.add(pipeline);
    void pipeline.run(1).catch((err) => {
      app.log.error({ err }, "linkedin pipeline crashed");
    });
    const snap = pipeline.snapshot();
    return reply.code(200).send({
      pipelineId: pipeline.pipelineId,
      startedAt: snap.startedAt,
      stages: snap.stages,
    });
  });

  app.post<{
    Params: { pipelineId: string };
    Body: { fromStage?: number };
    Reply: PipelineStartResponse | { error: string };
  }>("/api/jobs/linkedin/:pipelineId/resume", async (request, reply) => {
    const pipeline = app.linkedinPipelines.get(request.params.pipelineId);
    if (!pipeline) return reply.code(404).send({ error: "pipeline not found" });
    const snap = pipeline.snapshot();
    if (snap.status === "running") {
      return reply.code(409).send({ error: "pipeline is currently running" });
    }
    const requested = request.body?.fromStage;
    const inferred = resumeFromStage(snap);
    const fromStage = requested ?? inferred ?? 1;
    if (fromStage < 1 || fromStage > 6) {
      return reply.code(400).send({ error: `fromStage must be 1..6 (got ${fromStage})` });
    }
    void pipeline.run(fromStage).catch((err) => {
      app.log.error({ err }, "linkedin pipeline resume crashed");
    });
    const after = pipeline.snapshot();
    return reply.code(200).send({
      pipelineId: pipeline.pipelineId,
      startedAt: after.startedAt,
      stages: after.stages,
    });
  });

  app.get<{
    Params: { pipelineId: string };
    Reply: PipelineRecord | { error: string };
  }>("/api/jobs/linkedin/:pipelineId", async (request, reply) => {
    const pipeline = app.linkedinPipelines.get(request.params.pipelineId);
    if (!pipeline) return reply.code(404).send({ error: "pipeline not found" });
    return reply.code(200).send(pipeline.snapshot());
  });

  app.get<{ Params: { pipelineId: string } }>(
    "/sse/pipelines/:pipelineId",
    async (request, reply) => {
      const pipeline = app.linkedinPipelines.get(request.params.pipelineId);
      if (!pipeline) return reply.code(404).send({ error: "pipeline not found" });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      safeWrite(reply, `: connected pipelineId=${pipeline.pipelineId}\n\n`);

      // Initial snapshot so a late subscriber sees current state.
      safeWrite(
        reply,
        `event: snapshot\ndata: ${JSON.stringify(pipeline.snapshot())}\n\n`,
      );

      const onEvent = (ev: PipelineEvent) => {
        safeWrite(reply, `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      pipeline.emitter.on("event", onEvent);

      const heartbeat = setInterval(() => {
        safeWrite(reply, `: ping\n\n`);
      }, 15000);
      heartbeat.unref?.();

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        pipeline.emitter.off("event", onEvent);
        clearInterval(heartbeat);
      };
      request.raw.on("close", () => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
      });
    },
  );
};

export default linkedinPipelinePlugin;
