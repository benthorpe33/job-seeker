import Fastify from "fastify";
import cors from "@fastify/cors";

import type { HealthResponse } from "@job-seeker/shared";
import { HOST, PORT, REPO_ROOT, SERVER_VERSION } from "./env.js";
import { openDb } from "./index/db.js";
import { rebuildIndex } from "./index/rebuild.js";
import { startWatcher } from "./index/watcher.js";
import { JobRegistry } from "./jobs/registry.js";
import { jobsPlugin } from "./jobs/routes.js";
import { detectBash } from "./jobs/runner.js";
import { apiPlugin } from "./api/routes.js";

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

  // Decorate `app.jobs` and `app.jobsBashPath` at the ROOT scope so they're
  // visible to every sibling plugin (jobsPlugin, apiPlugin and its children).
  // Decorating inside jobsPlugin would scope them to that plugin's
  // encapsulation context only.
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
    app.log.info(
      `index rebuilt: applications=${counts.applications} reports=${counts.reports} scanHistory=${counts.scanHistory} pipelineEntries=${counts.pipelineEntries} (${counts.durationMs}ms)`,
    );

    const watcher = startWatcher({
      db,
      repoRoot: REPO_ROOT,
      logger: {
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m, e) => app.log.error({ err: e }, m),
      },
    });

    await app.register(apiPlugin({ db }));

    let closed = false;
    app.addHook("onClose", async () => {
      if (closed) return;
      closed = true;
      await watcher.close();
      db.close();
    });
    const shutdown = async (): Promise<void> => {
      await app.close();
    };
    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });

    const address = await app.listen({ host: HOST, port: PORT });
    app.log.info(
      `job_seeker server listening on ${address} (repoRoot=${REPO_ROOT})`,
    );
    if (!address.startsWith("http://127.0.0.1:")) {
      app.log.error(
        `Refusing to run: server is not bound to loopback (address=${address}). Aborting.`,
      );
      await shutdown();
      process.exit(1);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
