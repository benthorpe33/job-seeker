#!/usr/bin/env node
// Pre-fetch JDs → {tmpdir}/batch-jd-{id}.txt.
// Modes:
//   - No flags: scan batch-state.tsv for status=='failed' rows (recovery).
//   - --ids=a,b,c: prefetch the listed ids explicitly (preemptive, used by
//     batch-runner.sh main() before triage workers spawn — js-0zl).
// Strategy:
//   - Ashby URLs: hit /posting-api/job-board/{slug} (public), filter by job id.
//   - Greenhouse URLs: hit boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}.
//   - Other (Taleo, easyapply, custom) → skip (manual fetch needed).
//
// js-6d4: use os.tmpdir() rather than literal '/tmp'. On Windows, Node resolves
// '/tmp' to C:\tmp while Git Bash maps '/tmp' to %LOCALAPPDATA%\Temp — so a
// hardcoded '/tmp' here writes to a directory the bash worker (batch-runner.sh)
// never reads. os.tmpdir() returns %LOCALAPPDATA%\Temp on Windows, which is the
// same directory bash's '/tmp' mapping points at, so producer and consumer agree.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = tmpdir();

const INPUT = readFileSync('batch/batch-input.tsv', 'utf-8').split('\n');

// Build id → url map
const urlById = new Map();
for (const line of INPUT.slice(1)) {
  const [id, url] = line.split('\t');
  if (id && url) urlById.set(id, url);
}

// js-0zl: --ids=a,b,c selects an explicit id list (preemptive prefetch from
// batch-runner.sh).
// js-q4s: --all targets every id in batch-input.tsv. Used by the LinkedIn
// pipeline's reordered prefetch stage so the downstream filter has location
// JSON for every candidate row.
// Without either flag, fall back to the original behavior: scan
// batch-state.tsv for status=='failed' rows (post-failure recovery).
const idsArg = process.argv.find(a => a.startsWith('--ids='));
const allFlag = process.argv.includes('--all');
let targetIds;
if (idsArg) {
  targetIds = idsArg.slice('--ids='.length).split(',').map(s => s.trim()).filter(Boolean);
  console.log(`Target ids (--ids): ${targetIds.join(', ')}`);
} else if (allFlag) {
  targetIds = Array.from(urlById.keys());
  console.log(`Target ids (--all): ${targetIds.length} rows from batch-input.tsv`);
} else {
  const STATE = readFileSync('batch/batch-state.tsv', 'utf-8').split('\n');
  targetIds = [];
  for (const line of STATE.slice(1)) {
    const cols = line.split('\t');
    if (cols[0] && cols[2] === 'failed') targetIds.push(cols[0]);
  }
  console.log(`Failed ids: ${targetIds.join(', ')}`);
}

function decodeUrl(u) { return decodeURIComponent(u); }

async function fetchAshby(slug, jobId) {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(decodeUrl(slug))}?includeCompensation=true`;
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Ashby ${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const job = (json.jobs || []).find(j => j.id === jobId);
  if (!job) throw new Error(`Ashby ${slug}: job ${jobId} not in board`);

  // js-XXX: Ashby postings can list multiple eligible locations via
  // secondaryLocations. Folding them into a single "Locations:" line ensures
  // the triage worker sees every eligible city — without this, multi-city
  // postings (e.g. Ramp's "SF + NYC") get scored as if they were single-city
  // and locations the candidate prefers get silently dropped.
  const secondary = Array.isArray(job.secondaryLocations) ? job.secondaryLocations : [];
  const secondaryNames = secondary.map(s => s?.location).filter(Boolean);
  const allLocations = [job.location, ...secondaryNames].filter(Boolean);
  const locationLine = allLocations.length > 1
    ? `Locations: ${allLocations.join(' | ')}`
    : `Location: ${job.location || ''}`;

  const parts = [
    `Title: ${job.title}`,
    locationLine,
    `Workplace: ${job.workplaceType || ''}${typeof job.isRemote === 'boolean' ? ` (isRemote=${job.isRemote})` : ''}`,
    `Department: ${job.departmentName || ''}`,
    `Team: ${job.teamName || ''}`,
    `Employment: ${job.employmentType || ''}`,
    `Compensation: ${JSON.stringify(job.compensation || {}, null, 2)}`,
    `Posted: ${job.publishedAt || ''}`,
    `URL: ${job.jobUrl || ''}`,
    '',
    '--- Description ---',
    job.descriptionPlain || '(no description)',
  ];
  return {
    text: parts.join('\n'),
    location: { primary: job.location || '', secondary: secondaryNames, source: 'ashby' },
  };
}

async function fetchGreenhouse(slug, jobId) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`;
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Greenhouse ${slug}/${jobId}: HTTP ${res.status}`);
  const j = await res.json();
  const stripHtml = s => (s || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

  // Greenhouse multi-office postings populate the `offices` array. Surface
  // every office name so the worker doesn't lose eligible cities (parity with
  // the Ashby secondaryLocations fix).
  const officeNames = (j.offices || []).map(o => o?.name).filter(Boolean);
  const primary = j.location?.name || '';
  const secondary = officeNames.filter(n => n !== primary);
  const allLocations = [primary, ...secondary].filter(Boolean);
  const locationLine = allLocations.length > 1
    ? `Locations: ${allLocations.join(' | ')}`
    : `Location: ${primary}`;

  const text = [
    `Title: ${j.title}`,
    locationLine,
    `Department: ${(j.departments||[]).map(d=>d.name).join('; ')}`,
    `Updated: ${j.updated_at || ''}`,
    `URL: ${j.absolute_url || ''}`,
    '',
    '--- Description ---',
    stripHtml(j.content),
  ].join('\n');
  return { text, location: { primary, secondary, source: 'greenhouse' } };
}

// js-9df: apply-only URLs (LinkedIn EasyApply shorteners, raw HiBob/Greenhouse
// /apply pages without /jobs/{id}) never expose a JD anywhere — the page is
// only the application form. Detect them early so batch-runner.sh can
// short-circuit without spawning a triage worker.
function applyOnlyReason(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.host.toLowerCase();
  const path = u.pathname;
  if (host === 'easyapply.jobs' || host.endsWith('.easyapply.jobs')) {
    return 'easyapply.jobs (LinkedIn EasyApply shortener — no JD page)';
  }
  if (host.endsWith('.hibob.com') && /\/apply(\/|$)/i.test(path)) {
    return 'hibob.com /apply (application form only — no JD page)';
  }
  if ((host.endsWith('.greenhouse.io') || host === 'grnh.se') &&
      /\/apply(\/|$)/i.test(path) && !/\/jobs\/\d+/.test(path)) {
    return 'greenhouse.io /apply without /jobs/{id} (application form only)';
  }
  return null;
}

const results = { ok: [], skip: [], fail: [], applyOnly: [] };

for (const id of targetIds) {
  const url = urlById.get(id);
  if (!url) { results.skip.push(`${id} no-url`); continue; }

  const applyReason = applyOnlyReason(url);
  if (applyReason) {
    const markerPath = join(TMP, `batch-jd-${id}.skipped`);
    writeFileSync(markerPath, applyReason);
    results.applyOnly.push(`${id} → ${markerPath} (${applyReason})`);
    continue;
  }

  try {
    let result = null;
    let m;
    if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
      const slug = m[1];
      const jobId = m[2];
      result = await fetchAshby(slug, jobId);
    } else if ((m = url.match(/job-boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      result = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = url.match(/(?:boards|grnh\.se)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      result = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = url.match(/current\.com.*gh_jid=(\d+)/))) {
      // Try common Greenhouse slug for Current
      result = await fetchGreenhouse('current', m[1]);
    }
    if (!result) {
      results.skip.push(`${id} unsupported url: ${url.slice(0,80)}`);
      continue;
    }
    const { text, location } = result;
    const path = join(TMP, `batch-jd-${id}.txt`);
    writeFileSync(path, text);
    // Sidecar URL marker — batch-runner.sh checks this to detect stale JDs
    // when batch-input.tsv changes the URL for an existing id (js-oe9).
    writeFileSync(join(TMP, `batch-jd-${id}.url`), url);
    // js-q4s: Sidecar location JSON — filter-batch-input.mjs reads this to
    // drop non-target-location rows using the ATS API as source of truth
    // rather than the LinkedIn-derived notes column (which is empty for
    // Mistral / Cohere / many other postings).
    writeFileSync(
      join(TMP, `batch-jd-${id}.location.json`),
      JSON.stringify(location),
    );
    results.ok.push(`${id} → ${path} (${text.length} chars)`);
  } catch (e) {
    results.fail.push(`${id}: ${e.message}`);
  }
}

console.log('\n=== Results ===');
console.log(`OK (${results.ok.length}):`); results.ok.forEach(s => console.log('  ' + s));
console.log(`APPLY-ONLY (${results.applyOnly.length}):`); results.applyOnly.forEach(s => console.log('  ' + s));
console.log(`SKIP (${results.skip.length}):`); results.skip.forEach(s => console.log('  ' + s));
console.log(`FAIL (${results.fail.length}):`); results.fail.forEach(s => console.log('  ' + s));
