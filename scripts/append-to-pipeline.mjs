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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const RESOLVED = resolve(REPO, 'data', 'linkedin-resolved.json');
const SAVED = resolve(REPO, 'data', 'linkedin-saved-jobs.json');
const APPS = resolve(REPO, 'data', 'applications.md');
const PIPE = resolve(REPO, 'data', 'pipeline.md');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--yes');

const APPEND_DEDUP_OPTS = { threshold: 2, substringCompany: true };

function cleanCompany(cardText) {
  for (let i = 1; i < (cardText || []).length; i++) {
    const c = cardText[i].trim();
    if (!c || /^,?\s*Verified/i.test(c)) continue;
    return c;
  }
  return cardText?.[1] || '';
}
function cleanRole(cardText, fallback) {
  // Replace | with / so it doesn't collide with the pipeline.md "url | company | role | loc" separator.
  return (cardText?.[0] || fallback || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}
function cleanLocation(cardText) {
  for (const c of cardText || []) {
    if (/\((On-site|Hybrid|Remote)\)/i.test(c)) return c.trim();
  }
  return '';
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
for (const r of resolved.resolved) {
  if (r.applyKind !== 'offsite' || !r.applyUrl) continue;
  if (seen.has(r.jobId)) continue;
  seen.add(r.jobId);
  const src = savedById.get(r.jobId);
  const item = {
    jobId: r.jobId,
    applyUrl: r.applyUrl,
    company: cleanCompany(src?.cardText) || '',
    role: cleanRole(src?.cardText, r.title),
    location: cleanLocation(src?.cardText),
  };
  if (!item.company || !item.role) continue;
  if (pipeUrls.has(item.applyUrl)) continue;
  if (appsRows.some((a) => looksLikeDuplicate(item, a, APPEND_DEDUP_OPTS))) continue;
  if (pipeRows.some((p) => looksLikeDuplicate(item, p, APPEND_DEDUP_OPTS))) continue;
  propose.push(item);
}

const newLines = propose.map((p) => {
  const loc = p.location ? ` | ${p.location}` : '';
  return `- [ ] ${p.applyUrl} | ${p.company} | ${p.role}${loc}`;
});

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
