/*
  job_seeker SQLite index — REBUILT FROM CANONICAL FILES on each server start
  and on file-watcher events. NEVER the source of truth.

  Sources:
    data/applications.md   -> applications        (one row per pipe-table entry)
    reports/*.md           -> reports + reports_fts (one row per .md)
    data/scan-history.tsv  -> scan_history        (one row per TSV line)
    data/pipeline.md       -> pipeline_entries    (one row per checkbox item)

  Writeback contract: every mutation must produce the new markdown/TSV first,
  then the watcher re-parses and updates this index. `applications.raw_line`
  preserves the original markdown row text so T5 can do safe round-trip edits.
*/

CREATE TABLE applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  num         INTEGER,
  date        TEXT,
  company     TEXT,
  role        TEXT,
  score       REAL,
  status      TEXT,
  has_pdf     INTEGER NOT NULL DEFAULT 0,
  report_path TEXT,
  notes       TEXT,
  raw_line    TEXT NOT NULL
);
CREATE INDEX idx_applications_num     ON applications(num);
CREATE INDEX idx_applications_company ON applications(company);
CREATE INDEX idx_applications_status  ON applications(status);

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  num          INTEGER,
  slug         TEXT,
  date         TEXT,
  url          TEXT,
  score        REAL,
  legitimacy   TEXT,
  verification TEXT,
  blocks_json  TEXT NOT NULL DEFAULT '{}',
  body_md      TEXT NOT NULL,
  file_mtime   INTEGER NOT NULL
);
CREATE INDEX idx_reports_num   ON reports(num);
CREATE INDEX idx_reports_score ON reports(score);

CREATE VIRTUAL TABLE reports_fts USING fts5(
  id UNINDEXED,
  role,
  company,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE scan_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT,
  first_seen TEXT,
  portal     TEXT,
  title      TEXT,
  company    TEXT,
  status     TEXT
);
CREATE INDEX idx_scan_history_url ON scan_history(url);

CREATE TABLE pipeline_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  url      TEXT,
  company  TEXT,
  role     TEXT,
  location TEXT,
  checked  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rejections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER,
  ts             TEXT,
  reason         TEXT,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);
