import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { JobStartResponse } from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import { indexBus } from "../index/bus.js";
import type { DB } from "../index/db.js";
import { parseReportMd } from "../index/parsers/reportMd.js";
import { resolveKind } from "../jobs/kinds.js";
import { spawnJob } from "../jobs/runner.js";
import type { Job } from "../jobs/registry.js";
import {
  ApplicationRowNotFoundError,
  writeApplicationMutation,
} from "./writeback/applicationsMd.js";

const SENTINEL_OK_PREFIX = "FULL_REPORT_DONE:";
const PROMOTE_SCORE_GATE = 3.5;

type ReportLookup = {
  id: string;
  num: number | null;
  slug: string | null;
  date: string | null;
  url: string | null;
  score: number | null;
};

type ReconcileLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
};

export function extractFullReportSentinelPath(stdoutLines: string[]): string | null {
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const line = stdoutLines[i] ?? "";
    if (line.startsWith(SENTINEL_OK_PREFIX)) {
      return line.slice(SENTINEL_OK_PREFIX.length).trim();
    }
  }
  return null;
}

function formatScore(score: number): string {
  // applications.md score column shape: "X.X/5" (one decimal). The triage worker
  // sometimes emits "4.25/5" — preserve the source string when re-reading the
  // report rather than re-rounding here, so we never silently shave precision.
  // (See parseReportMd which only stores the numeric value.)
  const rounded = Math.round(score * 10) / 10;
  return `${rounded.toFixed(1)}/5`;
}

export type RegisterFullReportReconcileOpts = {
  job: Job;
  reportNum: number;
  reportPath: string;
  applicationsMdPath: string;
  db?: DB;
  log?: ReconcileLogger;
};

export function registerFullReportReconcileHook(opts: RegisterFullReportReconcileOpts): void {
  const { job, reportNum, reportPath, applicationsMdPath, db, log } = opts;
  job.emitter.once("done", (ev: { code: number | null; status: string }) => {
    if (ev.status !== "completed" || ev.code !== 0) return;
    try {
      const stdoutLines = job.ring
        .filter((e) => e.stream === "stdout")
        .map((e) => e.line);

      const sentinel = extractFullReportSentinelPath(stdoutLines);
      const resolved = sentinel ? resolve(sentinel) : null;
      // The sentinel is advisory — if it points somewhere unexpected, prefer
      // the path the orchestrator already knows. The worker is required by
      // its system prompt to overwrite that exact file.
      const finalPath = resolved && existsSync(resolved) ? resolved : reportPath;
      if (!existsSync(finalPath)) {
        log?.warn(
          `full-report: job ${job.jobId} exited 0 but report file missing at ${finalPath}`,
        );
        return;
      }

      const content = readFileSync(finalPath, "utf-8");
      const filename = finalPath.split(/[\\/]/).pop() ?? "";
      const mtime = Math.floor(statSync(finalPath).mtimeMs);
      const parsed = parseReportMd(filename, content, mtime);

      if (parsed.score === null) {
        log?.warn(
          `full-report: job ${job.jobId} produced a report with no Score header; leaving applications.md untouched`,
        );
        return;
      }

      const newScoreStr = formatScore(parsed.score);
      const result = writeApplicationMutation(applicationsMdPath, {
        num: reportNum,
        score: newScoreStr,
      });

      if (db) {
        db.prepare(
          `UPDATE applications SET score = ?, raw_line = ? WHERE num = ?`,
        ).run(parsed.score, result.after.rawLine, reportNum);
      }

      indexBus.emitUpdate({
        kind: "applications",
        op: "upsert",
        path: applicationsMdPath,
      });
      log?.info(
        `full-report: refined score for #${reportNum} → ${newScoreStr} (${finalPath})`,
      );
    } catch (err) {
      if (err instanceof ApplicationRowNotFoundError) {
        log?.warn(
          `full-report: applications.md row #${reportNum} not found; report file was rewritten but tracker was not`,
        );
        return;
      }
      log?.error("full-report: failed to reconcile score", err);
    }
  });
}

function resolveReportFromDb(db: DB, id: string): ReportLookup | undefined {
  const row = db
    .prepare(
      `SELECT id, num, slug, date, url, score FROM reports WHERE id = ?`,
    )
    .get(id) as ReportLookup | undefined;
  return row;
}

export const fullReportOrchestratorPlugin: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  function db(): DB {
    return app.indexDb;
  }

  app.post<{
    Body: { reportId?: string };
    Reply: JobStartResponse | { error: string };
  }>("/api/jobs/full-report/start", async (request, reply) => {
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
    if (report.score === null) {
      return reply
        .code(409)
        .send({ error: `report ${reportId} has no Score in its header — refusing to promote without a baseline` });
    }
    if (report.score >= PROMOTE_SCORE_GATE) {
      return reply.code(409).send({
        error: `report ${reportId} score ${report.score} >= ${PROMOTE_SCORE_GATE} — promote-to-full is for stubs only`,
      });
    }

    const userArgs = [
      String(report.num),
      report.slug,
      report.date,
      report.url,
    ];
    const bashPath = app.jobsBashPath;
    const resolved = resolveKind("full-report", userArgs, bashPath !== null);
    if ("ok" in resolved) {
      return reply.code(resolved.status).send({ error: resolved.message });
    }

    const cmd = bashPath ?? resolved.cmd;
    const job = spawnJob({
      kind: "full-report",
      cmd,
      args: resolved.args,
      cwd: REPO_ROOT,
      env: process.env,
      registry: app.jobs,
    });

    const reportPath = join(
      REPO_ROOT,
      "reports",
      `${String(report.num).padStart(3, "0")}-${report.slug}-${report.date}.md`,
    );

    registerFullReportReconcileHook({
      job,
      reportNum: report.num,
      reportPath,
      applicationsMdPath: join(REPO_ROOT, "data", "applications.md"),
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

export default fullReportOrchestratorPlugin;
