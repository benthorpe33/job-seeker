import Fastify from "fastify";
import cors from "@fastify/cors";

import type { HealthResponse } from "@job-seeker/shared";
import { HOST, PORT, REPO_ROOT, SERVER_VERSION } from "./env.js";
import { openDb } from "./index/db.js";
import { rebuildIndex } from "./index/rebuild.js";
import { jobsPlugin } from "./jobs/routes.js";

const startedAt = new Date().toISOString();

async function buildServer() {
  const app = Fastify({
    logger: {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l" },
      },
    },
  });

  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: false,
  });

  await app.register(jobsPlugin);

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    version: SERVER_VERSION,
    repoRoot: REPO_ROOT,
    startedAt,
  }));

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    const db = openDb();
    const counts = rebuildIndex(db, REPO_ROOT);
    db.close();
    app.log.info(
      `index rebuilt: applications=${counts.applications} reports=${counts.reports} scanHistory=${counts.scanHistory} pipelineEntries=${counts.pipelineEntries} (${counts.durationMs}ms)`,
    );
    const address = await app.listen({ host: HOST, port: PORT });
    app.log.info(
      `job_seeker server listening on ${address} (repoRoot=${REPO_ROOT})`,
    );
    if (!address.startsWith("http://127.0.0.1:")) {
      app.log.error(
        `Refusing to run: server is not bound to loopback (address=${address}). Aborting.`,
      );
      await app.close();
      process.exit(1);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
