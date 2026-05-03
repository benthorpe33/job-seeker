#!/usr/bin/env node
// Pre-fetch JDs for failed batch ids → /tmp/batch-jd-{id}.txt.
// Strategy:
//   - Ashby URLs: hit /posting-api/job-board/{slug} (public), filter by job id.
//   - Greenhouse URLs: hit boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}.
//   - Other (Taleo, easyapply, custom) → skip (manual fetch needed).

import { readFileSync, writeFileSync } from 'node:fs';

const STATE = readFileSync('batch/batch-state.tsv', 'utf-8').split('\n');
const INPUT = readFileSync('batch/batch-input.tsv', 'utf-8').split('\n');

// Build id → url map
const urlById = new Map();
for (const line of INPUT.slice(1)) {
  const [id, url] = line.split('\t');
  if (id && url) urlById.set(id, url);
}

// Find currently-failed ids (from state)
const failedIds = [];
for (const line of STATE.slice(1)) {
  const cols = line.split('\t');
  if (cols[0] && cols[2] === 'failed') failedIds.push(cols[0]);
}
console.log(`Failed ids: ${failedIds.join(', ')}`);

function decodeUrl(u) { return decodeURIComponent(u); }

async function fetchAshby(slug, jobId) {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(decodeUrl(slug))}?includeCompensation=true`;
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Ashby ${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const job = (json.jobs || []).find(j => j.id === jobId);
  if (!job) throw new Error(`Ashby ${slug}: job ${jobId} not in board`);
  const parts = [
    `Title: ${job.title}`,
    `Location: ${job.location}`,
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
  return parts.join('\n');
}

async function fetchGreenhouse(slug, jobId) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`;
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Greenhouse ${slug}/${jobId}: HTTP ${res.status}`);
  const j = await res.json();
  const stripHtml = s => (s || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return [
    `Title: ${j.title}`,
    `Location: ${j.location?.name || ''}`,
    `Department: ${(j.departments||[]).map(d=>d.name).join('; ')}`,
    `Updated: ${j.updated_at || ''}`,
    `URL: ${j.absolute_url || ''}`,
    '',
    '--- Description ---',
    stripHtml(j.content),
  ].join('\n');
}

const results = { ok: [], skip: [], fail: [] };

for (const id of failedIds) {
  const url = urlById.get(id);
  if (!url) { results.skip.push(`${id} no-url`); continue; }
  try {
    let text = null;
    let m;
    if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
      const slug = m[1];
      const jobId = m[2];
      text = await fetchAshby(slug, jobId);
    } else if ((m = url.match(/job-boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      text = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = url.match(/(?:boards|grnh\.se)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      text = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = url.match(/current\.com.*gh_jid=(\d+)/))) {
      // Try common Greenhouse slug for Current
      text = await fetchGreenhouse('current', m[1]);
    }
    if (!text) {
      results.skip.push(`${id} unsupported url: ${url.slice(0,80)}`);
      continue;
    }
    const path = `/tmp/batch-jd-${id}.txt`;
    writeFileSync(path, text);
    results.ok.push(`${id} → ${path} (${text.length} chars)`);
  } catch (e) {
    results.fail.push(`${id}: ${e.message}`);
  }
}

console.log('\n=== Results ===');
console.log(`OK (${results.ok.length}):`); results.ok.forEach(s => console.log('  ' + s));
console.log(`SKIP (${results.skip.length}):`); results.skip.forEach(s => console.log('  ' + s));
console.log(`FAIL (${results.fail.length}):`); results.fail.forEach(s => console.log('  ' + s));
