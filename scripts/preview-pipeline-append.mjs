#!/usr/bin/env node
// Preview which resolved LinkedIn saved jobs should be appended to data/pipeline.md.
//
// Reads:  data/linkedin-resolved.json
//         data/applications.md   (dedup against already-tracked roles)
//         data/pipeline.md       (dedup against pending roles)
// Writes: data/linkedin-pipeline-preview.md (human-readable; not the actual pipeline)
//
// No mutation of pipeline.md. After you review the preview, a second script appends approved entries.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const APPS = resolve(REPO, 'data', 'applications.md');
const PIPE = resolve(REPO, 'data', 'pipeline.md');
const OUT = resolve(REPO, 'data', 'linkedin-pipeline-preview.md');

const APPEND_DEDUP_OPTS = { threshold: 2, substringCompany: true };

function dupReason(saved, appsRows, pipeRows) {
  // Same order as append-to-pipeline.mjs: exact URL first, then fuzzy matches.
  if (pipeRows.some((p) => p.url === saved.applyUrl)) {
    return `pipeline.md: URL already present`;
  }
  for (const a of appsRows) {
    if (looksLikeDuplicate(saved, a, APPEND_DEDUP_OPTS)) {
      return `applications.md: ${a.company} — ${a.role}`;
    }
  }
  for (const p of pipeRows) {
    if (looksLikeDuplicate(saved, p, APPEND_DEDUP_OPTS)) {
      return `pipeline.md: ${p.company} — ${p.role}`;
    }
  }
  return null;
}

// --- main ---
if (!existsSync(RESOLVED)) {
  console.error(`missing ${RESOLVED} — run resolve-ats-urls.mjs first`);
  process.exit(1);
}
const resolved = JSON.parse(readFileSync(RESOLVED, 'utf8'));
const appsRows = existsSync(APPS) ? parseApplicationsRows(readFileSync(APPS, 'utf8')) : [];
const pipeRows = existsSync(PIPE) ? parsePipelineRows(readFileSync(PIPE, 'utf8')) : [];
const SAVED = resolve(REPO, 'data', 'linkedin-saved-jobs.json');
const savedById = existsSync(SAVED)
  ? new Map(JSON.parse(readFileSync(SAVED, 'utf8')).jobs.map((j) => [j.jobId, j]))
  : new Map();

const seenJobIds = new Set();
const buckets = { propose: [], dup: [], easyApply: [], closed: [], unknown: [], jobIdDup: [] };

for (const r of resolved.resolved) {
  if (seenJobIds.has(r.jobId)) {
    buckets.jobIdDup.push(r);
    continue;
  }
  seenJobIds.add(r.jobId);

  // Names come from the saved-jobs file (the source of truth for card text);
  // resolved.json's copies are the fallback when the job isn't in it.
  const fields = savedJobFields(savedById.get(r.jobId));
  const enriched = {
    ...r,
    company: fields.company || r.company,
    role: fields.title || r.title,
    location: fields.location || r.location,
  };

  if (r.applyKind === 'easyApply') { buckets.easyApply.push(enriched); continue; }
  if (r.applyKind === 'closed') { buckets.closed.push(enriched); continue; }
  if (r.applyKind !== 'offsite') { buckets.unknown.push(enriched); continue; }

  const dup = dupReason(enriched, appsRows, pipeRows);
  if (dup) buckets.dup.push({ ...enriched, dupReason: dup });
  else buckets.propose.push(enriched);
}

// Write preview markdown
const lines = [];
lines.push(`# LinkedIn saved-jobs → pipeline preview`);
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Source: data/linkedin-resolved.json (${resolved.resolved.length} resolved jobs)`);
lines.push('');
lines.push(`## Summary`);
lines.push(`- **${buckets.propose.length}** propose to append to pipeline.md`);
lines.push(`- ${buckets.dup.length} skipped — already in applications.md or pipeline.md`);
lines.push(`- ${buckets.jobIdDup.length} skipped — duplicate jobId in saved list`);
lines.push(`- ${buckets.easyApply.length} skipped — Easy Apply (LinkedIn-hosted)`);
lines.push(`- ${buckets.closed.length} skipped — posting closed`);
lines.push(`- ${buckets.unknown.length} skipped — could not resolve`);
lines.push('');
lines.push(`## Propose to append (${buckets.propose.length})`);
lines.push('');
lines.push('Each line is exactly what would be appended to `data/pipeline.md`:');
lines.push('');
lines.push('```');
for (const item of buckets.propose) {
  const loc = item.location ? ` | ${item.location}` : '';
  lines.push(`- [ ] ${item.applyUrl} | ${item.company} | ${item.role}${loc}`);
}
lines.push('```');
lines.push('');

if (buckets.dup.length) {
  lines.push(`## Skipped — duplicates (${buckets.dup.length})`);
  lines.push('');
  for (const item of buckets.dup) {
    lines.push(`- **${item.company}** — ${item.role}`);
    lines.push(`  - LinkedIn: ${item.listUrl}`);
    lines.push(`  - ATS: ${item.applyUrl}`);
    lines.push(`  - Matched: ${item.dupReason}`);
  }
  lines.push('');
}
if (buckets.jobIdDup.length) {
  lines.push(`## Skipped — duplicate jobIds (${buckets.jobIdDup.length})`);
  for (const item of buckets.jobIdDup) lines.push(`- ${item.jobId} — ${item.title}`);
  lines.push('');
}
if (buckets.easyApply.length) {
  lines.push(`## Skipped — Easy Apply (${buckets.easyApply.length})`);
  for (const item of buckets.easyApply) lines.push(`- **${item.company}** — ${item.role} (${item.listUrl})`);
  lines.push('');
}
if (buckets.closed.length) {
  lines.push(`## Skipped — closed (${buckets.closed.length})`);
  for (const item of buckets.closed) lines.push(`- **${item.company}** — ${item.role} (${item.listUrl})`);
  lines.push('');
}
if (buckets.unknown.length) {
  lines.push(`## Skipped — unresolved (${buckets.unknown.length})`);
  for (const item of buckets.unknown) lines.push(`- **${item.company}** — ${item.role} — ${item.error || 'no apply control'} (${item.listUrl})`);
  lines.push('');
}

writeFileSync(OUT, lines.join('\n'));
console.log(`[preview] wrote → ${OUT}`);
console.log(`[preview]   propose: ${buckets.propose.length}`);
console.log(`[preview]   skip-dup: ${buckets.dup.length}`);
console.log(`[preview]   skip-jobIdDup: ${buckets.jobIdDup.length}`);
console.log(`[preview]   skip-easyApply: ${buckets.easyApply.length}`);
console.log(`[preview]   skip-closed: ${buckets.closed.length}`);
console.log(`[preview]   skip-unknown: ${buckets.unknown.length}`);
