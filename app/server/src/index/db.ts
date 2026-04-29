import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database, { type Database as DB } from "better-sqlite3";

import { SERVER_DATA_DIR } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = join(SERVER_DATA_DIR, "index.db");

const SCHEMA_PATH = resolve(__dirname, "schema.sql");

const TABLES = [
  "rejections",
  "pipeline_entries",
  "scan_history",
  "reports_fts",
  "reports",
  "applications",
];

export function openDb(path: string = DEFAULT_DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function applySchema(db: DB): void {
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
}

export function dropAllTables(db: DB): void {
  for (const t of TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}

export function resetSchema(db: DB): void {
  dropAllTables(db);
  applySchema(db);
}

export type { DB };
