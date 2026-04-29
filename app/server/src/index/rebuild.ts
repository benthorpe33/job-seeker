import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { DB } from "./db.js";
import { resetSchema } from "./db.js";
import { parseApplicationsMd } from "./parsers/applicationsMd.js";
import { parsePipelineMd } from "./parsers/pipelineMd.js";
import { parseReportMd } from "./parsers/reportMd.js";
import { parseScanHistoryTsv } from "./parsers/scanHistoryTsv.js";

export type RebuildCounts = {
  applications: number;
  reports: number;
  scanHistory: number;
  pipelineEntries: number;
  durationMs: number;
};

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function rebuildApplications(db: DB, repoRoot: string): number {
  const content = readIfExists(join(repoRoot, "data", "applications.md"));
  if (content === null) return 0;
  const rows = parseApplicationsMd(content);
  const ins = db.prepare(
    `INSERT INTO applications
     (num, date, company, role, score, status, has_pdf, report_path, notes, raw_line)
     VALUES (@num, @date, @company, @role, @score, @status, @hasPdf, @reportPath, @notes, @rawLine)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) ins.run(r);
  });
  tx(rows);
  return rows.length;
}

function rebuildReports(db: DB, repoRoot: string): number {
  const dir = join(repoRoot, "reports");
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const insReport = db.prepare(
    `INSERT INTO reports
     (id, num, slug, date, url, score, legitimacy, verification,
      blocks_json, body_md, file_mtime)
     VALUES (@id, @num, @slug, @date, @url, @score, @legitimacy, @verification,
             @blocksJson, @bodyMd, @fileMtime)`,
  );
  const insFts = db.prepare(
    `INSERT INTO reports_fts (id, role, company, body) VALUES (?, ?, ?, ?)`,
  );

  const tx = db.transaction((names: string[]) => {
    for (const name of names) {
      const path = join(dir, name);
      const content = readFileSync(path, "utf-8");
      const mtime = Math.floor(statSync(path).mtimeMs);
      const r = parseReportMd(name, content, mtime);
      insReport.run({
        id: r.id,
        num: r.num,
        slug: r.slug,
        date: r.date,
        url: r.url,
        score: r.score,
        legitimacy: r.legitimacy,
        verification: r.verification,
        blocksJson: JSON.stringify(r.blocks),
        bodyMd: r.bodyMd,
        fileMtime: r.fileMtime,
      });
      // Pull role + company hints from the title line (first `# `) as
      // best-effort search facets — falls back to slug if absent.
      const titleLine = (r.bodyMd.split(/\r?\n/, 1)[0] ?? "").trim();
      insFts.run(r.id, titleLine, r.slug, r.bodyMd);
    }
  });
  tx(files);
  return files.length;
}

function rebuildScanHistory(db: DB, repoRoot: string): number {
  const content = readIfExists(join(repoRoot, "data", "scan-history.tsv"));
  if (content === null) return 0;
  const rows = parseScanHistoryTsv(content);
  const ins = db.prepare(
    `INSERT INTO scan_history (url, first_seen, portal, title, company, status)
     VALUES (@url, @firstSeen, @portal, @title, @company, @status)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) ins.run(r);
  });
  tx(rows);
  return rows.length;
}

function rebuildPipeline(db: DB, repoRoot: string): number {
  const content = readIfExists(join(repoRoot, "data", "pipeline.md"));
  if (content === null) return 0;
  const rows = parsePipelineMd(content);
  const ins = db.prepare(
    `INSERT INTO pipeline_entries (url, company, role, location, checked)
     VALUES (@url, @company, @role, @location, @checked)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) ins.run(r);
  });
  tx(rows);
  return rows.length;
}

export function rebuildIndex(db: DB, repoRoot: string): RebuildCounts {
  const t0 = Date.now();
  resetSchema(db);
  const applications = rebuildApplications(db, repoRoot);
  const reports = rebuildReports(db, repoRoot);
  const scanHistory = rebuildScanHistory(db, repoRoot);
  const pipelineEntries = rebuildPipeline(db, repoRoot);
  return {
    applications,
    reports,
    scanHistory,
    pipelineEntries,
    durationMs: Date.now() - t0,
  };
}
