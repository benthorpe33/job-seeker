#!/usr/bin/env node
// Filter batch/batch-input.tsv (LinkedIn pipeline stage 6, after stage 5
// prefetch — see js-q4s for the reorder rationale):
//   1. Drop URLs already evaluated (any URL appearing as `**URL:** <url>` in
//      reports/*.md). Avoids re-evaluating jobs the user already triaged.
//   2. Drop rows whose location is non-NYC and non-US-remote. Source of truth
//      preference (best → worst):
//        a. Prefetched ATS location JSON (js-q4s) at
//           batch/.jds/{id}.location.json — primary + secondary from
//           Ashby/Greenhouse APIs. Allow if ANY listed location matches NYC
//           or US-remote (covers SF-primary/NYC-secondary postings).
//        b. notes column 3rd pipe-segment (`Company | Role | Location`).
//        c. role-suffix scan (` - <city/region>` glued to the role text by
//           LinkedIn — Mistral's "Research Engineer, ML - Paris/London/...").
//      Empty after all three sources → kept (defer to evaluator).
//   3. Renumber surviving rows starting at id 1, then truncate
//      batch/batch-state.tsv to header-only so the renumbered ids don't
//      collide with stale state from previous runs. Also rename the
//      prefetched tmp files (.txt/.url/.location.json) from old id → new id
//      and delete tmp files for dropped rows so batch-runner.sh's preemptive
//      prefetch doesn't refetch survivors and doesn't carry orphan content.
//
// Run from the repo root. Idempotent: re-running on an already-filtered
// input is a no-op (assuming no new reports landed in between).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

import { normalizeUrl, loadEvaluatedUrls } from "./lib/reports-urls.mjs";

const INPUT_PATH = "batch/batch-input.tsv";
const STATE_PATH = "batch/batch-state.tsv";
// js-7dn: project-relative scratch dir matches batch-runner.sh + prefetch-jds.mjs.
// See those files for the full rationale (Node vs Git Bash /tmp mapping).
const JDS_DIR = "batch/.jds";
mkdirSync(JDS_DIR, { recursive: true });

const STATE_HEADER =
  "id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries";

const NYC_RE = /\b(nyc|new york|manhattan|brooklyn|queens|bronx)\b/i;
// Lifted from scripts/audit-multilocation.mjs — require a US qualifier so
// "Remote - EMEA" and "Remote - Brazil" don't slip through.
const REMOTE_US_RE =
  /\bremote\b.*\b(us|usa|united states|north america)\b|\b(us|usa|united states|north america)\b.*\bremote\b|\bremote (- )?us\b/i;
// Used only for the role-suffix fallback. Without this list, a role like
// "Senior - Backend Developer" would parse "Backend Developer" as a location
// and (since it doesn't match NYC/US-remote) drop the row. Restrict role-
// suffix drops to explicit foreign markers; otherwise defer to the evaluator.
const FOREIGN_LOC_RE =
  /\b(paris|london|berlin|munich|zurich|warsaw|amsterdam|rotterdam|dublin|barcelona|madrid|lisbon|porto|stockholm|oslo|copenhagen|helsinki|tokyo|seoul|singapore|sydney|melbourne|auckland|toronto|montreal|vancouver|sao\s*paulo|brazil|brasilia|rio|mexico|bogota|buenos aires|santiago|tel[\s-]*aviv|dubai|riyadh|cairo|lagos|johannesburg|nairobi|bangalore|hyderabad|mumbai|delhi|chennai|pune|jakarta|manila|bangkok|hanoi|kuala lumpur|hong kong|taipei|emea|apac|mena|latam|anz|europe|asia|africa|south america|latin america|middle east|morocco|france|germany|spain|italy|portugal|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|romania|czech|hungary|greece|turkey|israel|ireland|japan|china|india|korea|vietnam|thailand|malaysia|indonesia|philippines|australia|new zealand)\b/i;

// notes column shape (from linkedin-build-batch-input.mjs / append-to-pipeline.mjs):
//   "Company | Role | Location"  (Location optional)
function extractNotesLocation(notes) {
  if (typeof notes !== "string") return "";
  const parts = notes.split("|").map((s) => s.trim());
  if (parts.length < 3) return "";
  return parts.slice(2).join(" | ").trim();
}

// Catch the role-suffix encoding LinkedIn produces when a posting has multiple
// locations bundled in the title:
//   "Research Engineer, Machine Learning - Paris/London/Zurich/Warsaw"
//   "Forward Deployed Machine Learning Engineer - EMEA"
// Returns "" when no `- <segment>` suffix is present.
function extractRoleSuffix(notes) {
  if (typeof notes !== "string") return "";
  const parts = notes.split("|").map((s) => s.trim());
  if (parts.length < 2) return "";
  const role = parts[1] ?? "";
  const m = role.match(/[\s,]-\s+([^|]+?)\s*$/);
  return m ? m[1].trim() : "";
}

function loadAtsLocation(id) {
  const path = join(JDS_DIR, `${id}.location.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const primary = typeof parsed.primary === "string" ? parsed.primary : "";
    const secondary = Array.isArray(parsed.secondary)
      ? parsed.secondary.filter((s) => typeof s === "string" && s.trim())
      : [];
    if (!primary && secondary.length === 0) return null;
    return { primary, secondary, source: parsed.source ?? "unknown" };
  } catch {
    return null;
  }
}

function locationStringAllowed(loc) {
  if (!loc) return false;
  if (NYC_RE.test(loc)) return true;
  if (REMOTE_US_RE.test(loc)) return true;
  return false;
}

// Decide whether a row passes the location filter. Returns
// { allowed: boolean, source: "ats" | "notes" | "role-suffix" | "empty",
//   detail: string }.
function decideLocation(id, notes) {
  const ats = loadAtsLocation(id);
  if (ats) {
    const candidates = [ats.primary, ...ats.secondary];
    const allowed = candidates.some(locationStringAllowed);
    return {
      allowed,
      source: "ats",
      detail: candidates.filter(Boolean).join(" | "),
    };
  }
  const notesLoc = extractNotesLocation(notes);
  if (notesLoc) {
    return {
      allowed: locationStringAllowed(notesLoc),
      source: "notes",
      detail: notesLoc,
    };
  }
  const suffix = extractRoleSuffix(notes);
  if (suffix) {
    if (locationStringAllowed(suffix)) {
      return { allowed: true, source: "role-suffix", detail: suffix };
    }
    if (FOREIGN_LOC_RE.test(suffix)) {
      return { allowed: false, source: "role-suffix", detail: suffix };
    }
    // Suffix isn't a recognized location string (could be a role qualifier
    // like "Senior - Backend Developer"). Defer instead of false-dropping.
  }
  return { allowed: true, source: "empty", detail: "" };
}

function moveTmp(oldId, newId) {
  for (const ext of ["txt", "url", "location.json"]) {
    const from = join(JDS_DIR, `${oldId}.${ext}`);
    const to = join(JDS_DIR, `${newId}.${ext}`);
    if (!existsSync(from)) continue;
    if (from === to) continue;
    try {
      // If a file already sits at the destination from a previous run, drop it
      // first — the destination id may have been a different URL last time.
      if (existsSync(to)) {
        try {
          unlinkSync(to);
        } catch {
          /* ignore */
        }
      }
      renameSync(from, to);
    } catch {
      // Best effort — if the rename fails, batch-runner's stale-URL guard
      // and preemptive prefetch will recover.
    }
  }
}

function deleteTmp(id) {
  for (const ext of ["txt", "url", "location.json"]) {
    const path = join(JDS_DIR, `${id}.${ext}`);
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
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
  const dropped = [];
  let droppedTracked = 0;
  const droppedByLocSource = { ats: 0, notes: 0, "role-suffix": 0 };
  const droppedSamples = { tracked: [], ats: [], notes: [], "role-suffix": [] };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 4) continue;
    const [oldIdRaw, url, source, notes] = cols;
    const oldId = (oldIdRaw ?? "").trim();
    const norm = normalizeUrl(url);
    if (norm && evaluated.has(norm)) {
      droppedTracked += 1;
      if (droppedSamples.tracked.length < 3) droppedSamples.tracked.push(url);
      dropped.push({ oldId });
      continue;
    }
    const decision = decideLocation(oldId, notes);
    if (!decision.allowed) {
      droppedByLocSource[decision.source] = (droppedByLocSource[decision.source] ?? 0) + 1;
      const bucket = droppedSamples[decision.source];
      if (bucket && bucket.length < 3) {
        bucket.push(`${decision.detail} (${url})`);
      }
      dropped.push({ oldId });
      continue;
    }
    kept.push({ oldId, url, source, notes });
  }

  // Renumber + rename prefetched tmp files in lockstep so survivors keep their
  // prefetched JD/location sidecars under their new ids.
  const out = [header];
  let id = 1;
  for (const r of kept) {
    out.push(`${id}\t${r.url}\t${r.source}\t${r.notes}`);
    if (r.oldId && String(r.oldId) !== String(id)) {
      moveTmp(r.oldId, id);
    }
    id += 1;
  }
  for (const d of dropped) {
    if (d.oldId) deleteTmp(d.oldId);
  }
  writeFileSync(INPUT_PATH, out.join("\n") + "\n");

  // Truncate state.tsv so positional ids don't collide with stale rows.
  writeFileSync(STATE_PATH, STATE_HEADER + "\n");

  const totalLocationDropped =
    droppedByLocSource.ats +
    droppedByLocSource.notes +
    droppedByLocSource["role-suffix"];
  console.log(
    `Filter results: kept ${kept.length} · dropped ${droppedTracked} already-tracked · dropped ${totalLocationDropped} non-target-location ` +
      `(ats=${droppedByLocSource.ats}, notes=${droppedByLocSource.notes}, role-suffix=${droppedByLocSource["role-suffix"]})`,
  );
  if (droppedSamples.tracked.length > 0) {
    console.log("  sample dropped (tracked):");
    for (const s of droppedSamples.tracked) console.log(`    ${s}`);
  }
  for (const src of ["ats", "notes", "role-suffix"]) {
    if (droppedSamples[src].length > 0) {
      console.log(`  sample dropped (${src}):`);
      for (const s of droppedSamples[src]) console.log(`    ${s}`);
    }
  }
}

main();
