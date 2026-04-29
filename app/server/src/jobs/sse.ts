import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  JobDoneEvent,
  JobLogEvent,
} from "@job-seeker/shared";

import type { Job } from "./registry.js";

function safeWrite(reply: FastifyReply, payload: string): boolean {
  if (reply.raw.writableEnded || reply.raw.destroyed) return false;
  try {
    return reply.raw.write(payload);
  } catch {
    return false;
  }
}

function writeFrame(
  reply: FastifyReply,
  event: string,
  data: unknown,
  id?: number,
): void {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  safeWrite(reply, lines.join("\n") + "\n\n");
}

export function streamJobLogs(
  request: FastifyRequest,
  reply: FastifyReply,
  job: Job,
): void {
  const headerValue = request.headers["last-event-id"];
  const lastIdRaw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const queryLastId =
    typeof (request.query as { lastEventId?: unknown })?.lastEventId === "string"
      ? (request.query as { lastEventId: string }).lastEventId
      : undefined;
  const parsed = parseInt(lastIdRaw ?? queryLastId ?? "0", 10);
  const initialLastId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  safeWrite(reply, `: connected jobId=${job.jobId}\n\n`);

  // Highest id we've already pushed to this client. Updated by both replay
  // and the live listener so the two paths can't double-emit a line.
  let lastSentId = initialLastId;
  const sendIfNew = (ev: JobLogEvent) => {
    if (ev.id <= lastSentId) return;
    lastSentId = ev.id;
    writeFrame(reply, "line", ev, ev.id);
  };

  // Replay buffered lines newer than what the client has.
  for (const ev of job.ring) sendIfNew(ev);

  if (job.status !== "running") {
    writeFrame(reply, "done", {
      code: job.exitCode,
      signal: job.signal,
      status: job.status,
    });
    if (!reply.raw.writableEnded) reply.raw.end();
    return;
  }

  const onLine = (ev: JobLogEvent) => sendIfNew(ev);
  const onDone = (ev: JobDoneEvent) => {
    writeFrame(reply, "done", ev);
    cleanup();
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  const heartbeat = setInterval(() => {
    safeWrite(reply, `: ping\n\n`);
  }, 15000);
  heartbeat.unref?.();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    job.emitter.off("line", onLine);
    job.emitter.off("done", onDone);
    clearInterval(heartbeat);
  }

  job.emitter.on("line", onLine);
  job.emitter.on("done", onDone);

  // Close the race window: a line could have been pushed AND emitted between
  // the replay loop ending and `emitter.on("line", ...)` attaching above.
  // Re-scan the ring after attaching; sendIfNew dedupes via lastSentId.
  for (const ev of job.ring) sendIfNew(ev);

  request.raw.on("close", () => {
    cleanup();
    if (!reply.raw.writableEnded) reply.raw.end();
  });
}
