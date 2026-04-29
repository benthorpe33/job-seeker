import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import type { DB } from "./db.js";
import { indexBus, type IndexUpdateKind } from "./bus.js";
import { isLocked } from "./lock.js";
import { parseApplicationsMd } from "./parsers/applicationsMd.js";
import { parsePipelineMd } from "./parsers/pipelineMd.js";
import { parseReportMd } from "./parsers/reportMd.js";
import { parseScanHistoryTsv } from "./parsers/scanHistoryTsv.js";

const DEBOUNCE_MS = 500;
const STABILITY_THRESHOLD_MS = 300;
const POLL_INTERVAL_MS = 50;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
};

type WatcherKind =
  | { kind: "applications"; relPath: "data/applications.md" }
  | { kind: "scan_history"; relPath: "data/scan-history.tsv" }
  | { kind: "pipeline"; relPath: "data/pipeline.md" }
  | { kind: "rejections"; relPath: "data/rejection-feedback.tsv" }
  | { kind: "reports"; relPath: string /* reports/*.md */ };

export type StartWatcherOpts = {
  db: DB;
  repoRoot: string;
  logger?: Logger;
};

export type IndexWatcher = {
  watcher: FSWatcher;
  close: () => Promise<void>;
};

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function classify(repoRoot: string, absPath: string): WatcherKind | null {
  const rel = relative(repoRoot, absPath).split(sep).join("/");
  if (rel === "data/applications.md") {
    return { kind: "applications", relPath: rel };
  }
  if (rel === "data/scan-history.tsv") {
    return { kind: "scan_history", relPath: rel };
  }
  if (rel === "data/pipeline.md") {
    return { kind: "pipeline", relPath: rel };
  }
  if (rel === "data/rejection-feedback.tsv") {
    return { kind: "rejections", relPath: rel };
  }
  if (rel.startsWith("reports/") && rel.endsWith(".md")) {
    return { kind: "reports", relPath: rel };
  }
  return null;
}

function reindexApplications(db: DB, absPath: string): void {
  const content = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
  const rows = parseApplicationsMd(content);
  const ins = db.prepare(
    `INSERT INTO applications
     (num, date, company, role, score, status, has_pdf, report_path, notes, raw_line)
     VALUES (@num, @date, @company, @role, @score, @status, @hasPdf, @reportPath, @notes, @rawLine)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    db.exec("DELETE FROM applications");
    for (const r of batch) ins.run(r);
  });
  tx(rows);
}

function reindexScanHistory(db: DB, absPath: string): void {
  const content = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
  const rows = parseScanHistoryTsv(content);
  const ins = db.prepare(
    `INSERT INTO scan_history (url, first_seen, portal, title, company, status)
     VALUES (@url, @firstSeen, @portal, @title, @company, @status)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    db.exec("DELETE FROM scan_history");
    for (const r of batch) ins.run(r);
  });
  tx(rows);
}

function reindexPipeline(db: DB, absPath: string): void {
  const content = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
  const rows = parsePipelineMd(content);
  const ins = db.prepare(
    `INSERT INTO pipeline_entries (url, company, role, location, checked)
     VALUES (@url, @company, @role, @location, @checked)`,
  );
  const tx = db.transaction((batch: typeof rows) => {
    db.exec("DELETE FROM pipeline_entries");
    for (const r of batch) ins.run(r);
  });
  tx(rows);
}

function upsertReport(db: DB, absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  const filename = basename(absPath);
  const content = readFileSync(absPath, "utf-8");
  const mtime = Math.floor(statSync(absPath).mtimeMs);
  const r = parseReportMd(filename, content, mtime);
  const titleLine = (r.bodyMd.split(/\r?\n/, 1)[0] ?? "").trim();

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM reports WHERE id = ?`).run(r.id);
    db.prepare(`DELETE FROM reports_fts WHERE id = ?`).run(r.id);
    db.prepare(
      `INSERT INTO reports
       (id, num, slug, date, url, score, legitimacy, verification,
        blocks_json, body_md, file_mtime)
       VALUES (@id, @num, @slug, @date, @url, @score, @legitimacy, @verification,
               @blocksJson, @bodyMd, @fileMtime)`,
    ).run({
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
    db.prepare(
      `INSERT INTO reports_fts (id, role, company, body) VALUES (?, ?, ?, ?)`,
    ).run(r.id, titleLine, r.slug, r.bodyMd);
  });
  tx();
  return r.id;
}

function deleteReport(db: DB, absPath: string): string {
  const id = basename(absPath).replace(/\.md$/, "");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM reports WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM reports_fts WHERE id = ?`).run(id);
  });
  tx();
  return id;
}

function ensureRejectionsTable(db: DB): void {
  // The rejections feedback TSV is a lightweight key/value store created
  // lazily by T5; we don't have a parser yet — bus event is enough for now.
  void db;
}

export function startWatcher(opts: StartWatcherOpts): IndexWatcher {
  const { db, repoRoot } = opts;
  const log = opts.logger ?? NOOP_LOGGER;

  const targets = [
    join(repoRoot, "data", "applications.md"),
    join(repoRoot, "data", "scan-history.tsv"),
    join(repoRoot, "data", "pipeline.md"),
    join(repoRoot, "data", "rejection-feedback.tsv"),
    join(repoRoot, "reports"),
  ];

  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: POLL_INTERVAL_MS,
    },
    // Only watch *.md inside reports/, ignore other paths under it.
    ignored: (p: string) => {
      const norm = p.split(sep).join("/");
      const reportsPrefix = `${repoRoot.split(sep).join("/")}/reports/`;
      if (norm.startsWith(reportsPrefix) && !norm.endsWith(".md")) {
        // statSync to allow directory itself
        try {
          if (statSync(p).isDirectory()) return false;
        } catch {
          /* ignore */
        }
        return true;
      }
      return false;
    },
  });

  // Per-path debounce timers, keyed by absolute path.
  const timers: Map<string, NodeJS.Timeout> = new Map();

  function dispatch(absPath: string, op: "upsert" | "delete"): void {
    const abs = resolve(absPath);
    if (isLocked(abs)) {
      log.info(`watcher: skipping locked path ${abs}`);
      return;
    }
    const cls = classify(repoRoot, abs);
    if (!cls) return;

    try {
      let id: string | number | undefined;
      const kind: IndexUpdateKind = cls.kind;
      switch (cls.kind) {
        case "applications":
          if (op === "delete") {
            db.exec("DELETE FROM applications");
          } else {
            reindexApplications(db, abs);
          }
          break;
        case "scan_history":
          if (op === "delete") {
            db.exec("DELETE FROM scan_history");
          } else {
            reindexScanHistory(db, abs);
          }
          break;
        case "pipeline":
          if (op === "delete") {
            db.exec("DELETE FROM pipeline_entries");
          } else {
            reindexPipeline(db, abs);
          }
          break;
        case "rejections":
          ensureRejectionsTable(db);
          break;
        case "reports":
          if (op === "delete") {
            id = deleteReport(db, abs);
          } else {
            id = upsertReport(db, abs) ?? undefined;
          }
          break;
      }
      indexBus.emitUpdate({ kind, op, path: abs, id });
    } catch (err) {
      log.error(`watcher: failed to handle ${abs}`, err);
    }
  }

  function schedule(absPath: string, op: "upsert" | "delete"): void {
    const abs = resolve(absPath);
    const existing = timers.get(abs);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(abs);
      dispatch(abs, op);
    }, DEBOUNCE_MS);
    timers.set(abs, t);
  }

  watcher.on("add", (p) => schedule(p, "upsert"));
  watcher.on("change", (p) => schedule(p, "upsert"));
  watcher.on("unlink", (p) => schedule(p, "delete"));
  watcher.on("error", (err) => log.error("watcher: error", err));

  log.info(`watcher started (repoRoot=${repoRoot})`);

  async function close(): Promise<void> {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await watcher.close();
  }

  return { watcher, close };
}
