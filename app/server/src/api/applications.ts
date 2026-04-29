import { join } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { ApplicationRow } from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import type { DB } from "../index/db.js";
import { isCanonicalStatus } from "./states.js";
import { appendRejection } from "./rejections.js";
import {
  ApplicationRowNotFoundError,
  writeApplicationMutation,
} from "./writeback/applicationsMd.js";

const VALID_SORTS = new Set(["score", "date", "company", "role", "num"]);

type DbAppRow = {
  id: number;
  num: number | null;
  date: string | null;
  company: string | null;
  role: string | null;
  score: number | null;
  status: string | null;
  has_pdf: number;
  report_path: string | null;
  notes: string | null;
};

function toShared(row: DbAppRow): ApplicationRow {
  return {
    id: row.num ?? row.id,
    date: row.date ?? "",
    company: row.company ?? "",
    role: row.role ?? "",
    score: row.score,
    status: row.status ?? "",
    hasPdf: row.has_pdf === 1,
    reportPath: row.report_path,
    notes: row.notes ?? "",
  };
}

function selectAll(db: DB): DbAppRow[] {
  return db
    .prepare(
      `SELECT id, num, date, company, role, score, status, has_pdf, report_path, notes
       FROM applications`,
    )
    .all() as DbAppRow[];
}

function applySort(rows: DbAppRow[], sort: string, dir: "asc" | "desc"): DbAppRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmpStr = (a: string | null, b: string | null): number => {
    const x = a ?? "";
    const y = b ?? "";
    return x.localeCompare(y) * sign;
  };
  const cmpNum = (a: number | null, b: number | null): number => {
    // Nulls sort last regardless of dir.
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };
  const sorted = rows.slice();
  switch (sort) {
    case "score":
      sorted.sort((a, b) => cmpNum(a.score, b.score));
      break;
    case "date":
      sorted.sort((a, b) => cmpStr(a.date, b.date));
      break;
    case "company":
      sorted.sort((a, b) => cmpStr(a.company, b.company));
      break;
    case "role":
      sorted.sort((a, b) => cmpStr(a.role, b.role));
      break;
    case "num":
      sorted.sort((a, b) => cmpNum(a.num, b.num));
      break;
  }
  return sorted;
}

function ftsMatch(db: DB, q: string): Set<number> {
  // FTS5 MATCH; we OR the user terms. Sanitize: strip control chars and
  // double-quote each token to escape FTS operators.
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["()*]/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return new Set();
  const expr = tokens.map((t) => `"${t}"`).join(" OR ");
  try {
    const ids = db
      .prepare(`SELECT id FROM reports_fts WHERE reports_fts MATCH ?`)
      .all(expr) as { id: string }[];
    // reports.id is a filename slug; map to applications via report_path.
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => "?").join(",");
    const apps = db
      .prepare(
        `SELECT num FROM applications WHERE report_path IN (${placeholders})`,
      )
      .all(...ids.map((r) => `reports/${r.id}.md`)) as { num: number | null }[];
    return new Set(apps.map((r) => r.num).filter((n): n is number => n !== null));
  } catch {
    return new Set();
  }
}

export const applicationsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  function db(): DB {
    return app.indexDb;
  }

  app.get<{
    Querystring: {
      sort?: string;
      dir?: string;
      status?: string;
      q?: string;
    };
    Reply: { rows: ApplicationRow[]; total: number; query: Record<string, unknown> } | { error: string };
  }>("/api/applications", async (request, reply) => {
    const sort = VALID_SORTS.has(request.query.sort ?? "") ? (request.query.sort as string) : "score";
    const dir: "asc" | "desc" =
      request.query.dir === "asc" ? "asc" : request.query.dir === "desc" ? "desc" : "desc";
    const statusFilter = (request.query.status ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const q = (request.query.q ?? "").trim();

    let rows = selectAll(db());

    if (statusFilter.length > 0) {
      const set = new Set(statusFilter);
      rows = rows.filter((r) => set.has(r.status ?? ""));
    }

    if (q.length > 0) {
      const ql = q.toLowerCase();
      const substringMatches = new Set<number>();
      for (const r of rows) {
        const hay = `${r.company ?? ""}\n${r.role ?? ""}`.toLowerCase();
        if (hay.includes(ql)) {
          if (r.num !== null) substringMatches.add(r.num);
        }
      }
      const ftsMatches = q.length >= 3 ? ftsMatch(db(), q) : new Set<number>();
      const union = new Set<number>([...substringMatches, ...ftsMatches]);
      rows = rows.filter((r) => r.num !== null && union.has(r.num));
    }

    rows = applySort(rows, sort, dir);

    const out = rows.map(toShared);
    return reply.send({
      rows: out,
      total: out.length,
      query: { sort, dir, status: statusFilter, q },
    });
  });

  app.get<{
    Params: { id: string };
    Reply: ApplicationRow | { error: string };
  }>("/api/applications/:id", async (request, reply) => {
    const num = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: "id must be a number" });
    const row = db()
      .prepare(
        `SELECT id, num, date, company, role, score, status, has_pdf, report_path, notes
         FROM applications WHERE num = ?`,
      )
      .get(num) as DbAppRow | undefined;
    if (!row) return reply.code(404).send({ error: `application #${num} not found` });
    return reply.send(toShared(row));
  });

  app.patch<{
    Params: { id: string };
    Body: { status?: string; notes?: string; rejection_reason?: string };
    Reply: ApplicationRow | { error: string };
  }>("/api/applications/:id", async (request, reply) => {
    const num = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: "id must be a number" });
    const body = request.body ?? {};

    if (body.status !== undefined && !isCanonicalStatus(body.status)) {
      return reply.code(400).send({ error: `Status '${body.status}' is not canonical (see templates/states.yml)` });
    }
    if (body.status === "Discarded" && (!body.rejection_reason || body.rejection_reason.trim().length < 10)) {
      return reply.code(400).send({ error: "Discarded status requires a rejection_reason of at least 10 chars" });
    }

    // Find current row from DB to capture metadata for rejection log.
    const current = db()
      .prepare(
        `SELECT id, num, date, company, role, score, status, has_pdf, report_path, notes
         FROM applications WHERE num = ?`,
      )
      .get(num) as DbAppRow | undefined;
    if (!current) return reply.code(404).send({ error: `application #${num} not found` });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(REPO_ROOT, "data", "applications.md");

    try {
      const result = writeApplicationMutation(filePath, {
        num,
        status: body.status,
        notes: body.notes,
        // Bump date when status changes (and only then).
        date: body.status !== undefined ? today : undefined,
      });

      // Optimistically update the in-process DB so the response reflects the
      // change even before the watcher's debounced re-index fires.
      db()
        .prepare(
          `UPDATE applications
           SET status = ?, date = ?, notes = ?, raw_line = ?
           WHERE num = ?`,
        )
        .run(
          result.after.status,
          result.after.date,
          result.after.notes,
          result.after.rawLine,
          num,
        );

      if (body.status === "Discarded" && body.rejection_reason) {
        appendRejection({
          applicationId: num,
          company: current.company ?? "",
          role: current.role ?? "",
          score: current.score,
          reason: body.rejection_reason,
        });
      }

      const updated = db()
        .prepare(
          `SELECT id, num, date, company, role, score, status, has_pdf, report_path, notes
           FROM applications WHERE num = ?`,
        )
        .get(num) as DbAppRow;
      return reply.send(toShared(updated));
    } catch (err) {
      if (err instanceof ApplicationRowNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      app.log.error({ err }, "writeback failed");
      return reply.code(500).send({ error: "writeback failed" });
    }
  });
};

export default applicationsPlugin;
