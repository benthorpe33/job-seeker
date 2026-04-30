import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { JobStartResponse } from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import { indexBus } from "../index/bus.js";
import type { DB } from "../index/db.js";
import { resolveKind } from "../jobs/kinds.js";
import type { Job, JobRegistry } from "../jobs/registry.js";
import { spawnJob } from "../jobs/runner.js";
import {
  ApplicationRowNotFoundError,
  writeApplicationMutation,
} from "./writeback/applicationsMd.js";

const SENTINEL_OK_PREFIX = "GENERATE_CV_DONE:";

type ReportLookup = {
  id: string;
  num: number | null;
  slug: string | null;
  date: string | null;
  url: string | null;
};

type ReconcileLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
};

export function extractSentinelPath(stdoutLines: string[]): string | null {
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const line = stdoutLines[i] ?? "";
    if (line.startsWith(SENTINEL_OK_PREFIX)) {
      return line.slice(SENTINEL_OK_PREFIX.length).trim();
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function findGeneratedPdf(
  outputDir: string,
  slug: string,
  date: string,
  sinceMs?: number,
): string | null {
  if (!existsSync(outputDir)) return null;
  const pat = new RegExp(`^cv-.+-${escapeRegex(slug)}-${escapeRegex(date)}\\.pdf$`);
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(outputDir)) {
    if (!pat.test(name)) continue;
    const full = join(outputDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (sinceMs !== undefined && mtimeMs < sinceMs) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
  }
  return best ? best.path : null;
}

export type RegisterReconcileOpts = {
  job: Job;
  reportNum: number;
  slug: string;
  date: string;
  applicationsMdPath: string;
  outputDir: string;
  jobStartedMs: number;
  // Optional. When provided, the in-process DB row is updated synchronously
  // after the markdown mutation so SSE-triggered refetches see the new ✅
  // before the watcher picks the file change up. Mirrors the PATCH endpoint's
  // optimistic-update pattern in api/applications.ts.
  db?: DB;
  log?: ReconcileLogger;
};

export function registerPdfReconcileHook(opts: RegisterReconcileOpts): void {
  const { job, reportNum, slug, date, applicationsMdPath, outputDir, jobStartedMs, db, log } = opts;
  job.emitter.once("done", (ev: { code: number | null; status: string }) => {
    if (ev.status !== "completed" || ev.code !== 0) return;
    try {
      const stdoutLines = job.ring
        .filter((e) => e.stream === "stdout")
        .map((e) => e.line);
      let pdfPath: string | null = null;
      const sentinel = extractSentinelPath(stdoutLines);
      if (sentinel) {
        const abs = resolve(sentinel);
        if (existsSync(abs)) pdfPath = abs;
      }
      if (!pdfPath) {
        pdfPath = findGeneratedPdf(outputDir, slug, date, jobStartedMs);
      }
      if (!pdfPath) {
        log?.warn(
          `generate-cv: job ${job.jobId} exited 0 but no PDF found for slug=${slug} date=${date}`,
        );
        return;
      }
      const result = writeApplicationMutation(applicationsMdPath, {
        num: reportNum,
        pdf: "✅",
      });
      if (db) {
        db.prepare(
          `UPDATE applications SET has_pdf = 1, raw_line = ? WHERE num = ?`,
        ).run(result.after.rawLine, reportNum);
      }
      indexBus.emitUpdate({
        kind: "applications",
        op: "upsert",
        path: applicationsMdPath,
      });
      log?.info(`generate-cv: marked PDF ✅ for #${reportNum} (${pdfPath})`);
    } catch (err) {
      if (err instanceof ApplicationRowNotFoundError) {
        log?.warn(
          `generate-cv: applications.md row #${reportNum} not found; skipping PDF mark`,
        );
        return;
      }
      log?.error("generate-cv: failed to reconcile PDF column", err);
    }
  });
}

function resolveReportFromDb(db: DB, id: string): ReportLookup | undefined {
  const row = db
    .prepare(
      `SELECT id, num, slug, date, url FROM reports WHERE id = ?`,
    )
    .get(id) as ReportLookup | undefined;
  return row;
}

export const cvOrchestratorPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  function db(): DB {
    return app.indexDb;
  }

  app.post<{
    Body: { reportId?: string };
    Reply: JobStartResponse | { error: string };
  }>("/api/jobs/generate-cv/start", async (request, reply) => {
    const reportId = (request.body?.reportId ?? "").trim();
    if (!reportId) return reply.code(400).send({ error: "reportId is required" });

    const report = resolveReportFromDb(db(), reportId);
    if (!report) return reply.code(404).send({ error: `report ${reportId} not found` });
    if (report.num === null) {
      return reply
        .code(409)
        .send({ error: `report ${reportId} has no num — cannot reconcile applications.md` });
    }
    if (!report.slug || !report.date) {
      return reply.code(409).send({ error: `report ${reportId} is missing slug or date` });
    }
    if (!report.url) {
      return reply.code(409).send({ error: `report ${reportId} has no URL in its header` });
    }

    const userArgs = [
      String(report.num),
      report.slug,
      report.date,
      report.url,
    ];
    const bashPath = app.jobsBashPath;
    const resolved = resolveKind("generate-cv", userArgs, bashPath !== null);
    if ("ok" in resolved) {
      return reply.code(resolved.status).send({ error: resolved.message });
    }

    const cmd = bashPath ?? resolved.cmd;
    const job = spawnJob({
      kind: "generate-cv",
      cmd,
      args: resolved.args,
      cwd: REPO_ROOT,
      env: process.env,
      registry: app.jobs,
    });

    registerPdfReconcileHook({
      job,
      reportNum: report.num,
      slug: report.slug,
      date: report.date,
      applicationsMdPath: join(REPO_ROOT, "data", "applications.md"),
      outputDir: join(REPO_ROOT, "output"),
      jobStartedMs: job.startedAtMs,
      db: db(),
      log: {
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m, e) => app.log.error({ err: e }, m),
      },
    });

    return reply.code(200).send({
      jobId: job.jobId,
      kind: job.kind,
      startedAt: job.startedAt,
    });
  });
};

export default cvOrchestratorPlugin;
