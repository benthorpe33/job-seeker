import { join } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { ReportDetail, ReportHeader } from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import type { DB } from "../index/db.js";

type DbReportRow = {
  id: string;
  num: number | null;
  slug: string | null;
  date: string | null;
  url: string | null;
  score: number | null;
  legitimacy: string | null;
  verification: string | null;
  blocks_json: string;
  body_md: string;
};

function toDetail(row: DbReportRow, applicationNum: number | null): ReportDetail {
  let blocks: Record<string, string> = {};
  try {
    blocks = JSON.parse(row.blocks_json) as Record<string, string>;
  } catch {
    blocks = {};
  }
  const header: ReportHeader = {
    url: row.url,
    score: row.score,
    legitimacy: row.legitimacy,
    verification: row.verification,
  };
  return {
    id: row.id,
    num: row.num ?? 0,
    slug: row.slug ?? row.id,
    date: row.date ?? "",
    header,
    blocks,
    bodyMd: row.body_md,
    filePath: join("reports", `${row.id}.md`),
    applicationNum,
  };
}

function lookupApplicationNum(db: DB, reportId: string): number | null {
  const row = db
    .prepare(`SELECT num FROM applications WHERE report_path = ?`)
    .get(`reports/${reportId}.md`) as { num: number | null } | undefined;
  return row?.num ?? null;
}

export const reportsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  function db(): DB {
    return app.indexDb;
  }

  app.get<{ Params: { id: string }; Reply: ReportDetail | { error: string } }>(
    "/api/reports/:id",
    async (request, reply) => {
      const id = request.params.id;
      const row = db()
        .prepare(
          `SELECT id, num, slug, date, url, score, legitimacy, verification,
                  blocks_json, body_md
           FROM reports WHERE id = ?`,
        )
        .get(id) as DbReportRow | undefined;
      if (!row) return reply.code(404).send({ error: `report ${id} not found` });
      const applicationNum = lookupApplicationNum(db(), id);
      return reply.send(toDetail(row, applicationNum));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/reports/:id/raw",
    async (request, reply) => {
      const id = request.params.id;
      const row = db()
        .prepare(`SELECT body_md FROM reports WHERE id = ?`)
        .get(id) as { body_md: string } | undefined;
      if (!row) return reply.code(404).type("text/plain").send(`report ${id} not found`);
      return reply.type("text/plain; charset=utf-8").send(row.body_md);
    },
  );

  void REPO_ROOT;
};

export default reportsPlugin;
