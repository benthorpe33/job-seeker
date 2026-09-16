#!/usr/bin/env node
// Append the proposed entries from linkedin-resolved.json to data/pipeline.md.
// Re-runs the same dedup/clean logic as preview-pipeline-append.mjs (single source of truth — DO NOT
// rely on parsing the preview file). Shows a diff and asks for --yes before writing.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseApplicationsRows,
  parsePipelineRows,
  looksLikeDuplicate,
} from './lib/dedup.mjs';
import { savedJobFields } from './lib/linkedin-card.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const RESOLVED = resolve(REPO, 'data', 'linkedin-resolved.json');
const SAVED = resolve(REPO, 'data', 'linkedin-saved-jobs.json');
const APPS = resolve(REPO, 'data', 'applications.md');
const PIPE = resolve(REPO, 'data', 'pipeline.md');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--yes');

const APPEND_DEDUP_OPTS = { threshold: 2, substringCompany: true };

// pipeline.md lines are "url | company | role | loc" — keep | out of the fields.
function pipeField(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

// --- main ---
const resolved = JSON.parse(readFileSync(RESOLVED, 'utf8'));
const saved = JSON.parse(readFileSync(SAVED, 'utf8'));
const savedById = new Map(saved.jobs.map((j) => [j.jobId, j]));
const appsRows = parseApplicationsRows(readFileSync(APPS, 'utf8'));
const pipeMd = readFileSync(PIPE, 'utf8');
const pipeRows = parsePipelineRows(pipeMd);
const pipeUrls = new Set(pipeRows.map((r) => r.url));

const seen = new Set();
const propose = [];
const dropped = []; // { r, reason }
let offsiteCount = 0;
for (const r of resolved.resolved) {
  if (r.applyKind !== 'offsite' || !r.applyUrl) {
    dropped.push({ r, reason: r.applyKind === 'unknown' || !r.applyKind ? `unresolved (${r.error || 'no error recorded'})` : r.applyKind });
    continue;
  }
  if (seen.has(r.jobId)) continue;
  seen.add(r.jobId);
  offsiteCount++;
  const fields = savedJobFields(savedById.get(r.jobId));
  const item = {
    jobId: r.jobId,
    applyUrl: r.applyUrl,
    company: pipeField(fields.company || r.company),
    role: pipeField(fields.title || r.title),
    location: pipeField(fields.location || r.location),
  };
  if (!item.company || !item.role) { dropped.push({ r, reason: 'missing company or role' }); continue; }
  if (pipeUrls.has(item.applyUrl)) { dropped.push({ r, reason: 'URL already in pipeline.md' }); continue; }
  if (appsRows.some((a) => looksLikeDuplicate(item, a, APPEND_DEDUP_OPTS))) { dropped.push({ r, reason: 'duplicate of applications.md row' }); continue; }
  if (pipeRows.some((p) => looksLikeDuplicate(item, p, APPEND_DEDUP_OPTS))) { dropped.push({ r, reason: 'duplicate of pipeline.md row' }); continue; }
  propose.push(item);
}

const newLines = propose.map((p) => {
  const loc = p.location ? ` | ${p.location}` : '';
  return `- [ ] ${p.applyUrl} | ${p.company} | ${p.role}${loc}`;
});

console.log(`[append] ${resolved.resolved.length} resolved rows: ${newLines.length} to add, ${dropped.length} skipped`);
for (const { r, reason } of dropped) {
  console.log(`[append]   skip ${r.jobId} ${r.company || '?'} — ${r.title || '?'}: ${reason}`);
}

// Rows that resolved fine but can't be named mean the saved-jobs card parse
// broke; don't let that masquerade as "nothing new to add".
const unnamed = dropped.filter((d) => d.reason === 'missing company or role').length;
if (offsiteCount > 0 && unnamed === offsiteCount) {
  console.error(`[append] all ${offsiteCount} resolved offsite jobs lack a company or role — check data/linkedin-saved-jobs.json parsing`);
  process.exit(7);
}

console.log(`[append] would add ${newLines.length} lines to ${PIPE}`);
console.log(`[append] preview of first 3:`);
for (const l of newLines.slice(0, 3)) console.log(`  ${l}`);
if (newLines.length > 3) console.log(`  ... (+${newLines.length - 3} more)`);

if (!APPLY) {
  console.log(`\n[append] DRY RUN — re-run with --yes to actually append.`);
  process.exit(0);
}

// Append: insert under "## Pendientes" header, after existing entries.
const lines = pipeMd.split('\n');
let lastEntry = -1;
let pendientesIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^##\s+Pendientes/.test(lines[i])) pendientesIdx = i;
  if (pendientesIdx >= 0 && i > pendientesIdx && /^- \[[ x]\]/.test(lines[i])) lastEntry = i;
}
if (pendientesIdx < 0) {
  console.error('[append] could not find ## Pendientes section in pipeline.md — aborting');
  process.exit(1);
}
const insertAt = lastEntry >= 0 ? lastEntry + 1 : pendientesIdx + 2;

// Backup first
const backup = PIPE + '.bak.' + Date.now();
copyFileSync(PIPE, backup);
console.log(`[append] backup → ${backup}`);

const newPipe = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)].join('\n');
writeFileSync(PIPE, newPipe);
console.log(`[append] wrote ${newLines.length} new entries to ${PIPE}`);
