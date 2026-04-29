import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import { indexBus, type IndexUpdateEvent } from "../index/bus.js";

const HEARTBEAT_MS = 15_000;

function safeWrite(reply: FastifyReply, payload: string): boolean {
  if (reply.raw.writableEnded || reply.raw.destroyed) return false;
  try {
    return reply.raw.write(payload);
  } catch {
    return false;
  }
}

export const indexSsePlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/sse/index", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    safeWrite(reply, `: connected\n\n`);

    const onUpdate = (ev: IndexUpdateEvent) => {
      const data = JSON.stringify({
        kind: ev.kind,
        op: ev.op,
        path: ev.path,
        id: ev.id,
      });
      safeWrite(reply, `event: index\ndata: ${data}\n\n`);
    };
    indexBus.on("index:updated", onUpdate);

    const heartbeat = setInterval(() => {
      safeWrite(reply, `: ping\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      indexBus.off("index:updated", onUpdate);
      clearInterval(heartbeat);
    };

    request.raw.on("close", () => {
      cleanup();
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
};

export default indexSsePlugin;
