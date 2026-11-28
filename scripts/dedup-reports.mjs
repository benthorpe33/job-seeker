#!/usr/bin/env node
// Dedup duplicate reports (same URL evaluated multiple times) and the matching
// rows in data/applications.md. dedup-tracker.mjs only collapses rows whose
// company+role fuzzy-match; URL-equal rows with differently-worded role
// strings (the common batch-duplicate pattern) slip past it.
//
// Same-date duplicates are treated as bugs (a single batch run shouldn't
// produce two reports for one URL). Different-date duplicates are treated as
// intentional re-evals and left alone.
//
// Tie-break within a same-date duplicate group:
//   1. Filename-slug-matches-URL-slug wins (catches cross-company
//      contamination: a report whose filename slug names a different company
//      than its URL is the contaminated one to delete).
//   2. Among slug-matchers, the higher report number wins (later = more
//      refined verdict in two-pass batch).
//   3. Among non-slug-matchers (all contaminated), the higher number wins
//      arbitrarily — both are suspect and should be re-evaluated, but at
//      least we collapse to one.
//
// Default is dry-run. Pass --apply to actually delete files and rewrite
// applications.md.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const REPORTS_DIR = 'reports';
const APPS_FILE = 'data/applications.md';

if (!existsSync(REPORTS_DIR) || !existsSync(APPS_FILE)) {
  console.error(`Need ${REPORTS_DIR}/ and ${APPS_FILE}`);
  process.exit(1);
}

// Map URL → ATS slug (the company portion of an ATS URL).
function urlSlug(url) {
  let m;
  if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return m[1].toLowerCase();
  if ((m = url.match(/(?:job-boards|boards|grnh\.se)\.greenhouse\.io\/([^/?#]+)/i))) return m[1].toLowerCase();
  if ((m = url.match(/jobs\.lever\.co\/([^/?#]+)/i))) return m[1].toLowerCase();
  return null;
}

function filenameSlug(filename) {
  // 333-ramp-2026-05-04.md → "ramp"
  // 274-onyx-odds-2026-05-03.md → "onyx-odds"
  // 005-anthropic-applied-ai-digital-natives-2026-04-22.md → "anthropic-applied-ai-digital-natives"
  const m = filename.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  return m ? m[1].toLowerCase() : null;
}

function fileDate(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return m ? m[1] : null;
}

function reportNum(filename) {
  return parseInt(filename.match(/^(\d+)/)[1], 10);
}

// Walk reports, harvest (file, url, date, num, slug, urlSlug, slugMatch).
const reports = [];
for (const f of readdirSync(REPORTS_DIR).filter(f => /^\d+-.+\.md$/.test(f))) {
  const text = readFileSync(join(REPORTS_DIR, f), 'utf-8');
  const m = text.match(/\*\*URL:\*\*\s*(\S+)/i);
  if (!m) continue;
  const url = m[1].replace(/[·,.]+$/, '');
  const fSlug = filenameSlug(f);
  const uSlug = urlSlug(url);
  // Slug-match: filename slug contains the URL's ATS slug (loose; tolerates
  // "ramp" vs "ramp-com" and "anthropic-fde-applied-ai" vs "anthropic").
  const slugMatch = uSlug && fSlug && (fSlug.includes(uSlug) || uSlug.includes(fSlug.split('-')[0]));
  reports.push({
    file: f,
    url,
    date: fileDate(f),
    num: reportNum(f),
    fSlug,
    uSlug,
    slugMatch: slugMatch ?? false,
  });
}

// Group by URL.
const byUrl = new Map();
for (const r of reports) {
  if (!byUrl.has(r.url)) byUrl.set(r.url, []);
  byUrl.get(r.url).push(r);
}

// Plan = { keep, delete, reason } per duplicate group.
const plan = [];
const keepReports = []; // for cross-check
const deleteReports = [];
const skipDifferentDate = [];
const contaminatedGroups = [];

for (const [url, group] of byUrl) {
  if (group.length < 2) continue;
  // Partition by date.
  const byDate = new Map();
  for (const r of group) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  for (const [date, sameDate] of byDate) {
    if (sameDate.length < 2) {
      // Single report on this date — but other dates exist for this URL.
      // Leave it alone (intentional refresh).
      if (group.length > sameDate.length) {
        skipDifferentDate.push({ url, files: group.map(r => r.file) });
      }
      continue;
    }
    // Skip groups containing any non-slug-match entry — those are URL-collision
    // cases where the body evaluates a different company than the URL points to
    // (cross-company contamination). Deleting them would drop a unique
    // evaluation. Surface them separately for manual review.
    const allSlugMatch = sameDate.every(r => r.slugMatch);
    if (!allSlugMatch) {
      contaminatedGroups.push({ url, date, reports: sameDate });
      continue;
    }
    // Tie-break: higher report number wins (later = more refined two-pass verdict).
    sameDate.sort((a, b) => b.num - a.num);
    const keep = sameDate[0];
    const losers = sameDate.slice(1);
    plan.push({ url, date, keep, losers });
    keepReports.push(keep);
    for (const l of losers) deleteReports.push(l);
  }
}

// Pretty-print plan.
console.log(`=== Dedup plan ===`);
console.log(`Total reports:        ${reports.length}`);
console.log(`Unique URLs:          ${byUrl.size}`);
console.log(`Same-date dup groups: ${plan.length}`);
console.log(`Reports to delete:    ${deleteReports.length}`);
console.log(`Cross-date URLs (left alone): ${skipDifferentDate.length}`);
console.log('');

for (const { url, date, keep, losers } of plan) {
  console.log(`URL: ${url}`);
  console.log(`  KEEP   reports/${keep.file}  (num=${keep.num})`);
  for (const l of losers) {
    console.log(`  DELETE reports/${l.file}  (num=${l.num})`);
  }
  console.log('');
}

if (contaminatedGroups.length > 0) {
  console.log(`--- Contaminated URL-collision groups (NOT touched — manual review) ---`);
  for (const { url, date, reports: rs } of contaminatedGroups) {
    console.log(`URL: ${url}`);
    for (const r of rs) {
      const tag = r.slugMatch ? 'slug-match' : 'WRONG-URL';
      console.log(`  reports/${r.file}  (num=${r.num}, ${tag})`);
    }
    console.log('');
  }
}

if (skipDifferentDate.length > 0) {
  console.log(`--- Cross-date URLs preserved (assumed intentional re-evals) ---`);
  for (const { url, files } of skipDifferentDate) {
    console.log(`  ${url}`);
    for (const f of files) console.log(`    reports/${f}`);
  }
  console.log('');
}

console.log(`Contaminated groups left for manual review: ${contaminatedGroups.length}`);
console.log('');

if (!APPLY) {
  console.log(`(dry-run — pass --apply to delete files and rewrite ${APPS_FILE})`);
  process.exit(0);
}

// === APPLY ===
console.log(`=== Applying ===`);
const deletedNums = new Set(deleteReports.map(r => r.num));

// 1) Delete report files.
for (const r of deleteReports) {
  unlinkSync(join(REPORTS_DIR, r.file));
  console.log(`  rm reports/${r.file}`);
}

// 2) Rewrite applications.md.
//   - If both keeper-row and loser-row exist → drop loser-row (keeper-row stays).
//   - If only loser-row exists → RELINK the row's link to the keeper.
//   - Else → no-op.
// Build maps: linked-report-num → row text (so we know what's in the tracker).
const appsText = readFileSync(APPS_FILE, 'utf-8');
const appsLines = appsText.split('\n');
const linkedNums = new Set();
for (const line of appsLines) {
  const m = line.match(/\[(\d+)\]\(reports\/(\d+)-/);
  if (m) linkedNums.add(parseInt(m[2], 10));
}

// Build per-loser action: "drop" or "relink" → keeperFilePath.
const loserAction = new Map(); // num → { kind: 'drop' | 'relink', keepFile, keepNum, keepRowDisplay }
for (const { keep, losers } of plan) {
  const keepHasRow = linkedNums.has(keep.num);
  for (const l of losers) {
    if (keepHasRow) {
      loserAction.set(l.num, { kind: 'drop' });
    } else {
      loserAction.set(l.num, {
        kind: 'relink',
        keepFile: keep.file,
        keepNum: keep.num,
      });
    }
  }
}

const out = [];
let droppedRows = 0;
let relinkedRows = 0;
for (const line of appsLines) {
  const linkMatch = line.match(/\[(\d+)\]\(reports\/(\d+)-[^)]+\)/);
  if (!linkMatch) {
    out.push(line);
    continue;
  }
  const linkedNum = parseInt(linkMatch[2], 10);
  const action = loserAction.get(linkedNum);
  if (!action) {
    out.push(line);
    continue;
  }
  if (action.kind === 'drop') {
    droppedRows++;
    console.log(`  drop applications.md row → reports/${linkMatch[2]}-...`);
    continue;
  }
  // relink: rewrite the [num](reports/num-...) substring to point at the keeper
  const newLink = `[${String(action.keepNum).padStart(3, '0')}](reports/${action.keepFile})`;
  const newLine = line.replace(linkMatch[0], newLink);
  console.log(`  relink applications.md row: [${linkMatch[1]}] → [${String(action.keepNum).padStart(3, '0')}] (${action.keepFile})`);
  out.push(newLine);
  relinkedRows++;
}
writeFileSync(APPS_FILE, out.join('\n'));
console.log(`  rewrote ${APPS_FILE} (dropped ${droppedRows} rows, relinked ${relinkedRows} rows)`);

console.log('');
console.log(`Deleted ${deleteReports.length} report files, dropped ${droppedRows} rows, relinked ${relinkedRows} rows.`);
console.log(`Kept ${keepReports.length} canonical reports (one per URL+date).`);
