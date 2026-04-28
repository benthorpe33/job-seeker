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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const RESOLVED = resolve(REPO, 'data', 'linkedin-resolved.json');
const APPS = resolve(REPO, 'data', 'applications.md');
const PIPE = resolve(REPO, 'data', 'pipeline.md');
const OUT = resolve(REPO, 'data', 'linkedin-pipeline-preview.md');

const norm = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s, stop) => {
  const arr = norm(s).split(' ').filter((t) => t.length > 2 && !stop.has(t));
  return new Set(arr);
};
const STOP = new Set([
  'senior', 'staff', 'principal', 'lead', 'engineer', 'scientist', 'data',
  'analyst', 'developer', 'software', 'technical', 'member',
  'forward', 'deployed', 'applied', 'solutions', 'architect', 'machine',
  'learning', 'analytics', 'product', 'and', 'the', 'for',
]);

function cleanCompany(cardText) {
  // LinkedIn inserts ", Verified" badge text between title and company. The real company
  // is the first cardText[i] (i >= 1) that isn't a verification badge or location-like.
  for (let i = 1; i < (cardText || []).length; i++) {
    const c = cardText[i].trim();
    if (!c) continue;
    if (/^,?\s*Verified/i.test(c)) continue;
    return c;
  }
  return cardText?.[1] || '';
}

function cleanRole(cardText, fallback) {
  return (cardText?.[0] || fallback || '').replace(/\s+/g, ' ').trim();
}

function cleanLocation(cardText) {
  // Find a line that looks like "<City>, <State> (<Mode>)" or "United States (Remote)"
  for (const c of cardText || []) {
    if (/\((On-site|Hybrid|Remote)\)/i.test(c)) return c.trim();
  }
  return '';
}

function parseAppsMd(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---') || /\|\s*#\s*\|/.test(line)) continue;
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 5 || !c[3] || !c[4]) continue;
    rows.push({ company: c[3], role: c[4] });
  }
  return rows;
}

function parsePipelineMd(md) {
  // Pipeline format: - [ ] URL | Company | Role | Location...
  const rows = [];
  for (const line of md.split('\n')) {
    if (!/^- \[[ x]\]/.test(line)) continue;
    const parts = line.replace(/^- \[[ x]\]\s*/, '').split(' | ');
    if (parts.length < 3) continue;
    rows.push({ url: parts[0].trim(), company: parts[1]?.trim() || '', role: parts[2]?.trim() || '' });
  }
  return rows;
}

function isDup(saved, existing) {
  const cn = norm(saved.company);
  const en = norm(existing.company);
  if (!cn || !en) return false;
  // Same company name (allow substring match for "Anthropic" vs "Anthropic Inc")
  const sameCompany = cn === en || cn.includes(en) || en.includes(cn);
  if (!sameCompany) return false;
  // Same role: ≥2 shared non-stopword tokens OR exact normalized match
  if (norm(saved.role) === norm(existing.role)) return true;
  const ts = tokens(saved.role, STOP);
  const te = tokens(existing.role, STOP);
  let shared = 0;
  for (const t of ts) if (te.has(t)) shared++;
  return shared >= 2;
}

function dupReason(saved, appsRows, pipeRows) {
  for (const a of appsRows) if (isDup(saved, a)) return `applications.md: ${a.company} — ${a.role}`;
  for (const p of pipeRows) if (isDup(saved, p)) return `pipeline.md: ${p.company} — ${p.role}`;
  return null;
}

// --- main ---
if (!existsSync(RESOLVED)) {
  console.error(`missing ${RESOLVED} — run resolve-ats-urls.mjs first`);
  process.exit(1);
}
const resolved = JSON.parse(readFileSync(RESOLVED, 'utf8'));
const appsRows = existsSync(APPS) ? parseAppsMd(readFileSync(APPS, 'utf8')) : [];
const pipeRows = existsSync(PIPE) ? parsePipelineMd(readFileSync(PIPE, 'utf8')) : [];

const seenJobIds = new Set();
const buckets = { propose: [], dup: [], easyApply: [], closed: [], unknown: [], jobIdDup: [] };

for (const r of resolved.resolved) {
  if (seenJobIds.has(r.jobId)) {
    buckets.jobIdDup.push(r);
    continue;
  }
  seenJobIds.add(r.jobId);

  const enriched = {
    ...r,
    company: cleanCompany(r.cardText) || r.company,
    role: cleanRole(r.cardText, r.title),
    location: cleanLocation(r.cardText) || r.location,
  };
  // re-fetch cardText from input json for cleaner names
  // (resolveOne stripped some context — pull back from input file)
  if (!enriched.company) {
    const input = JSON.parse(readFileSync(resolve(REPO, 'data', 'linkedin-saved-jobs.json'), 'utf8'));
    const src = input.jobs.find((j) => j.jobId === r.jobId);
    if (src) {
      enriched.company = cleanCompany(src.cardText);
      enriched.role = cleanRole(src.cardText, r.title);
      enriched.location = cleanLocation(src.cardText);
    }
  }

  if (r.applyKind === 'easyApply') { buckets.easyApply.push(enriched); continue; }
  if (r.applyKind === 'closed') { buckets.closed.push(enriched); continue; }
  if (r.applyKind !== 'offsite') { buckets.unknown.push(enriched); continue; }

  const dup = dupReason(enriched, appsRows, pipeRows);
  if (dup) buckets.dup.push({ ...enriched, dupReason: dup });
  else buckets.propose.push(enriched);
}

// Re-parse cardText cleanly from source file (resolved.json doesn't store it)
const input = JSON.parse(readFileSync(resolve(REPO, 'data', 'linkedin-saved-jobs.json'), 'utf8'));
const inputById = new Map(input.jobs.map((j) => [j.jobId, j]));
for (const list of [buckets.propose, buckets.dup, buckets.easyApply, buckets.closed, buckets.unknown]) {
  for (const item of list) {
    const src = inputById.get(item.jobId);
    if (src) {
      item.company = cleanCompany(src.cardText);
      item.role = cleanRole(src.cardText, item.title);
      item.location = cleanLocation(src.cardText);
    }
  }
}
// Re-run dedup with cleaned company names (some "Verified" entries may now match)
const finalPropose = [];
for (const item of buckets.propose) {
  const dup = dupReason(item, appsRows, pipeRows);
  if (dup) buckets.dup.push({ ...item, dupReason: dup });
  else finalPropose.push(item);
}
buckets.propose = finalPropose;

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
