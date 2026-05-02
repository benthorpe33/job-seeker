import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type {
  DraftFile,
  DraftRequest,
  DraftStartResponse,
  ScrapedField,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import type { DB } from "../index/db.js";
import { resolveKind } from "../jobs/kinds.js";
import { spawnJob } from "../jobs/runner.js";
import {
  draftsPathFor,
  fieldsPathFor,
  readDraftsFile,
  registerDraftReconcileHook,
} from "../scraper/draftReconcile.js";
import { isPiiLabel } from "../scraper/pii.js";

const PHONE_REGEX = /\d{3}-\d{3}-\d{4}/;
const REPORT_ID_REGEX = /^[A-Za-z0-9._-]+$/;
const MAX_FIELDS = 50;

type ReportLookup = {
  id: string;
  num: number | null;
  slug: string | null;
  date: string | null;
  url: string | null;
};

function resolveReportFromDb(db: DB, id: string): ReportLookup | undefined {
  return db
    .prepare(`SELECT id, num, slug, date, url FROM reports WHERE id = ?`)
    .get(id) as ReportLookup | undefined;
}

type ValidatedRequest = {
  reportId: string;
  fields: ScrapedField[];
  applyUrl: string | null;
};

type ValidationFailure = { status: 400; error: string };

function validateBody(body: Partial<DraftRequest> | undefined): ValidatedRequest | ValidationFailure {
  if (!body || typeof body !== "object") {
    return { status: 400, error: "request body must be a JSON object" };
  }
  const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
  if (!reportId) {
    return { status: 400, error: "reportId is required" };
  }
  if (!REPORT_ID_REGEX.test(reportId)) {
    return {
      status: 400,
      error: "reportId contains invalid characters (allowed: alphanumeric, dot, dash, underscore)",
    };
  }
  if (!Array.isArray(body.fields) || body.fields.length === 0) {
    return { status: 400, error: "fields must be a non-empty array" };
  }
  if (body.fields.length > MAX_FIELDS) {
    return { status: 400, error: `fields exceeds maximum of ${MAX_FIELDS}` };
  }
  const fields: ScrapedField[] = [];
  for (const raw of body.fields) {
    if (!raw || typeof raw !== "object") {
      return { status: 400, error: "each field must be an object" };
    }
    const f = raw as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id : "";
    const label = typeof f.label === "string" ? f.label : "";
    const type = f.type === "text" || f.type === "textarea" ? f.type : null;
    if (!id || !label || !type) {
      return { status: 400, error: "each field requires id, label, and type" };
    }
    if (isPiiLabel(label)) {
      return {
        status: 400,
        error: `field label "${label}" is on the PII blocklist; refusing to draft`,
      };
    }
    if (PHONE_REGEX.test(label)) {
      return {
        status: 400,
        error: `field label "${label}" looks like a phone-input field; refusing to draft`,
      };
    }
    const required = Boolean(f.required);
    const maxLen =
      typeof f.maxLen === "number" && Number.isFinite(f.maxLen) && f.maxLen > 0
        ? Math.trunc(f.maxLen)
        : undefined;
    fields.push({ id, label, type, required, maxLen });
  }
  let applyUrl: string | null = null;
  if (typeof body.applyUrl === "string" && body.applyUrl.trim()) {
    try {
      const u = new URL(body.applyUrl.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { status: 400, error: "applyUrl must be an http(s) URL" };
      }
      applyUrl = u.toString();
    } catch {
      return { status: 400, error: "applyUrl is malformed" };
    }
  }
  return { reportId, fields, applyUrl };
}

export const draftOrchestratorPlugin: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  function db(): DB {
    return app.indexDb;
  }

  app.post<{
    Body: Partial<DraftRequest>;
    Reply: DraftStartResponse | { error: string };
  }>("/api/scraper/draft", async (request, reply) => {
    const validated = validateBody(request.body);
    if ("status" in validated) {
      return reply.code(validated.status).send({ error: validated.error });
    }

    const report = resolveReportFromDb(db(), validated.reportId);
    if (!report) {
      return reply
        .code(404)
        .send({ error: `report ${validated.reportId} not found` });
    }
    if (report.num === null || !report.slug || !report.date) {
      return reply.code(409).send({
        error: `report ${validated.reportId} missing num/slug/date — cannot orchestrate draft`,
      });
    }

    const applyUrl = validated.applyUrl ?? report.url ?? null;
    const fieldsFilePath = fieldsPathFor(REPO_ROOT, validated.reportId);
    const draftsPath = draftsPathFor(REPO_ROOT, validated.reportId);

    try {
      mkdirSync(dirname(fieldsFilePath), { recursive: true });
      writeFileSync(
        fieldsFilePath,
        JSON.stringify(
          {
            reportId: validated.reportId,
            applyUrl,
            fields: validated.fields,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply
        .code(500)
        .send({ error: `failed to write draft fields file: ${message}` });
    }

    const userArgs = [
      String(report.num),
      report.slug,
      report.date,
      fieldsFilePath,
    ];
    const bashPath = app.jobsBashPath;
    const resolved = resolveKind("draft-answers", userArgs, bashPath !== null);
    if ("ok" in resolved) {
      return reply.code(resolved.status).send({ error: resolved.message });
    }

    const cmd = bashPath ?? resolved.cmd;
    const job = spawnJob({
      kind: "draft-answers",
      cmd,
      args: resolved.args,
      cwd: REPO_ROOT,
      env: process.env,
      registry: app.jobs,
    });

    registerDraftReconcileHook({
      job,
      reportId: validated.reportId,
      applyUrl,
      draftsPath,
      fieldsFilePath,
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

  app.get<{
    Params: { reportId: string };
    Reply: DraftFile | { error: string };
  }>("/api/scraper/drafts/:reportId", async (request, reply) => {
    const reportId = (request.params.reportId ?? "").trim();
    if (!reportId) {
      return reply.code(400).send({ error: "reportId is required" });
    }
    if (!REPORT_ID_REGEX.test(reportId)) {
      return reply.code(400).send({ error: "reportId contains invalid characters" });
    }
    const path = draftsPathFor(REPO_ROOT, reportId);
    const file = readDraftsFile(path);
    if (!file) {
      return reply.code(404).send({ error: `no drafts found for report ${reportId}` });
    }
    return reply.code(200).send(file);
  });
};

export default draftOrchestratorPlugin;
