#!/usr/bin/env node
// Filter batch/batch-input.tsv (stage 4.5 / new stage 5):
//   1. Drop URLs already evaluated (any URL appearing as `**URL:** <url>` in
//      reports/*.md). Avoids re-evaluating jobs the user already triaged.
//   2. Drop rows whose location is clearly non-NYC and non-remote. Empty
//      locations are kept (let the stage-6 evaluator's hard filters decide).
//   3. Renumber surviving rows starting at id 1, then truncate
//      batch/batch-state.tsv to header-only so the renumbered ids don't
//      collide with stale state from previous runs.
//
// Run from the repo root. Idempotent: re-running on an already-filtered
// input is a no-op (assuming no new reports landed in between).

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INPUT_PATH = "batch/batch-input.tsv";
const STATE_PATH = "batch/batch-state.tsv";
const REPORTS_DIR = "reports";

const STATE_HEADER =
  "id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries";

const NYC_RE = /\b(nyc|new york|manhattan|brooklyn|queens|bronx)\b/i;
const REMOTE_RE = /\bremote\b/i;

function normalizeUrl(u) {
  if (typeof u !== "string") return "";
  const trimmed = u.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function loadEvaluatedUrls() {
  const set = new Set();
  let entries;
  try {
    entries = readdirSync(REPORTS_DIR);
  } catch {
    return set; // no reports yet
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(REPORTS_DIR, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const text = readFileSync(path, "utf-8");
    // Only scan the first ~30 lines — header is always near the top.
    const head = text.split(/\r?\n/, 30).join("\n");
    const m = head.match(/^\*\*URL:\*\*\s+(\S.*?)\s*$/m);
    if (!m) continue;
    const norm = normalizeUrl(m[1]);
    if (norm) set.add(norm);
  }
  return set;
}

// notes column shape (from linkedin-build-batch-input.mjs / append-to-pipeline.mjs):
//   "Company | Role | Location"  (Location optional)
function extractLocation(notes) {
  if (typeof notes !== "string") return "";
  const parts = notes.split("|").map((s) => s.trim());
  // [company, role, location?] — location is the last part if there are 3+
  if (parts.length < 3) return "";
  return parts.slice(2).join(" | ").trim();
}

function locationAllowed(loc) {
  if (!loc) return true; // empty → defer to evaluator
  if (NYC_RE.test(loc)) return true;
  if (REMOTE_RE.test(loc)) return true;
  return false;
}

function main() {
  const evaluated = loadEvaluatedUrls();

  const raw = readFileSync(INPUT_PATH, "utf-8");
  const lines = raw.split(/\r?\n/);
  const header = lines[0] ?? "";
  if (!header.startsWith("id\turl\tsource\tnotes")) {
    console.error(`ERROR: ${INPUT_PATH} missing expected header`);
    process.exit(1);
  }

  const kept = [];
  let droppedTracked = 0;
  let droppedLocation = 0;
  const droppedSamples = { tracked: [], location: [] };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 4) continue;
    const [, url, source, notes] = cols;
    const norm = normalizeUrl(url);
    if (norm && evaluated.has(norm)) {
      droppedTracked += 1;
      if (droppedSamples.tracked.length < 3) droppedSamples.tracked.push(url);
      continue;
    }
    const loc = extractLocation(notes);
    if (!locationAllowed(loc)) {
      droppedLocation += 1;
      if (droppedSamples.location.length < 3) droppedSamples.location.push(`${loc} (${url})`);
      continue;
    }
    kept.push({ url, source, notes });
  }

  // Renumber surviving rows starting at id 1.
  const out = [header];
  let id = 1;
  for (const r of kept) {
    out.push(`${id}\t${r.url}\t${r.source}\t${r.notes}`);
    id += 1;
  }
  writeFileSync(INPUT_PATH, out.join("\n") + "\n");

  // Truncate state.tsv so positional ids don't collide with stale rows.
  writeFileSync(STATE_PATH, STATE_HEADER + "\n");

  console.log(
    `Filter results: kept ${kept.length} · dropped ${droppedTracked} already-tracked · dropped ${droppedLocation} non-target-location`,
  );
  if (droppedSamples.tracked.length > 0) {
    console.log("  sample dropped (tracked):");
    for (const s of droppedSamples.tracked) console.log(`    ${s}`);
  }
  if (droppedSamples.location.length > 0) {
    console.log("  sample dropped (location):");
    for (const s of droppedSamples.location) console.log(`    ${s}`);
  }
}

main();
