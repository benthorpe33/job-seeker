#!/usr/bin/env node
// Pre-fetch JDs → batch/.jds/{id}.txt.
// Modes:
//   - No flags: scan batch-state.tsv for status=='failed' rows (recovery).
//   - --ids=a,b,c: prefetch the listed ids explicitly (preemptive, used by
//     batch-runner.sh main() before triage workers spawn — js-0zl).
// Strategy:
//   - Ashby URLs: hit /posting-api/job-board/{slug} (public), filter by job id.
//   - Greenhouse URLs: hit boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}.
//   - Other (Taleo, easyapply, custom) → skip (manual fetch needed).
//
// js-7dn: project-relative scratch dir (batch/.jds/) instead of os.tmpdir().
// js-6d4 fixed the producer-side mapping by routing through os.tmpdir(), but
// the consumer (claude -p workers) runs as Node — so when the resolved prompt
// said `Read /tmp/batch-jd-{id}.txt` the worker looked in C:\tmp on Windows
// and got ENOENT, while the bash runner's `! -s` check on the same /tmp path
// resolved to %LOCALAPPDATA%\Temp and saw the runner-created empty placeholder.
// A project-relative path resolves identically under bash and Node and removes
// the implicit env-var dependency entirely.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const JDS_DIR = 'batch/.jds';
mkdirSync(JDS_DIR, { recursive: true });

const INPUT = readFileSync('batch/batch-input.tsv', 'utf-8').split('\n');

// Build id → url map
const urlById = new Map();
// Company name (first notes segment), used to guess Ashby board slugs for
// company-hosted ?ashby_jid= pages.
const companyById = new Map();
for (const line of INPUT.slice(1)) {
  const [id, url, , notes] = line.split('\t');
  if (id && url) urlById.set(id, url);
  if (id && notes) companyById.set(id, notes.split('|')[0].trim());
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

// js-f7g: company careers pages with ?gh_jid={id} are Greenhouse-backed but
// the board slug rarely matches the bare hostname. First guess from the
// hostname (www.brex.com → brex); if that 404s, fetch the page and sniff
// the slug from any embedded Greenhouse iframe / link.
function guessSlugFromHostname(host) {
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^(careers|jobs|apply)\./, '')
    .split('.')[0];
}

async function discoverGhSlugFromHtml(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (career-ops prefetch)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Greenhouse renders iframes via boards.greenhouse.io/embed/job_board?for=SLUG
    // and direct links via {boards,job-boards}.greenhouse.io/SLUG/...
    const patterns = [
      // /embed/job_board?for=SLUG and /embed/job_board/js?for=SLUG
      /(?:boards|job-boards)\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i,
      /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[1] !== 'embed') return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchGreenhouseWithGhJid(pageUrl, jobId) {
  const u = new URL(pageUrl);
  const guess = guessSlugFromHostname(u.host);
  try {
    return await fetchGreenhouse(guess, jobId);
  } catch (firstErr) {
    const sniffed = await discoverGhSlugFromHtml(pageUrl);
    if (sniffed && sniffed !== guess) {
      return await fetchGreenhouse(sniffed, jobId);
    }
    throw firstErr;
  }
}

// js-mj0: company careers pages with ?ashby_jid={uuid} (voleon.com/jobs,
// withdavid.ai/jobs) embed an Ashby board client-side, so neither WebFetch
// nor HTML sniffing can see the JD or the slug. Try the slugs it's likely to
// be: the hostname label (voleon.com → voleon), then the company name
// slugified (David AI → david-ai, davidai).
function ashbySlugCandidates(host, company) {
  const out = [guessSlugFromHostname(host)];
  const c = (company || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  if (c) {
    out.push(c.replace(/\s+/g, '-'), c.replace(/\s+/g, ''));
    const first = c.split(/\s+/)[0];
    if (first) out.push(first);
  }
  return [...new Set(out.filter(Boolean))];
}

async function fetchAshbyWithJid(pageUrl, jobId, company) {
  const host = new URL(pageUrl).host;
  let lastErr = null;
  for (const slug of ashbySlugCandidates(host, company)) {
    try {
      return await fetchAshby(slug, jobId);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Ashby ashby_jid ${jobId}: no slug candidate matched`);
}

// js-mj0: Lever postings. LinkedIn often links Lever's /apply form, which has
// no JD text, so WebFetch got only the form (Lirvana Labs, 2026-11-26). The
// public postings API returns the full posting for both /{id} and /{id}/apply.
async function fetchLever(slug, postingId) {
  const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${postingId}`;
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Lever ${slug}/${postingId}: HTTP ${res.status}`);
  const j = await res.json();
  const cats = j.categories || {};
  const all = cats.allLocations && cats.allLocations.length ? cats.allLocations : [cats.location].filter(Boolean);
  const sal = j.salaryRange
    ? `${j.salaryRange.currency || ''} ${j.salaryRange.min}–${j.salaryRange.max} (${j.salaryRange.interval || ''})`
    : (j.salaryDescriptionPlain || '').trim() || 'not listed';
  const lists = (j.lists || [])
    .map((l) => `${l.text}\n${(l.content || '').replace(/<li>/gi, '- ').replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n').trim()}`)
    .join('\n\n');
  const text = [
    `Title: ${j.text}`,
    all.length > 1 ? `Locations: ${all.join(' | ')}` : `Location: ${all[0] || ''}`,
    `Workplace: ${j.workplaceType || ''}`,
    `Team: ${cats.team || ''}`,
    `Employment: ${cats.commitment || ''}`,
    `Created: ${j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : ''}`,
    `Compensation: ${sal}`,
    `URL: ${j.hostedUrl || ''}`,
    '',
    '--- Description ---',
    (j.descriptionPlain || '').trim(),
    '',
    lists,
    '',
    (j.additionalPlain || '').trim(),
  ].join('\n');
  return {
    text,
    location: { primary: all[0] || '', secondary: all.slice(1), source: 'lever' },
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

// js-mj0: ids are renumbered every pipeline run, so {id}.txt/.url/
// .location.json/.skipped can belong to an unrelated posting from an earlier
// run. Seen 2026-11-26: row 3 (Lirvana Labs) still had a Figma PhD JD plus an
// easyapply .skipped marker, and the location filter read stale
// .location.json. If an id's sidecar URL doesn't match its current URL (or is
// missing), drop every sidecar before deciding what to write. An unsupported
// or failed fetch then leaves nothing behind, instead of stale content.
function clearStaleSidecars(id, url) {
  const urlPath = join(JDS_DIR, `${id}.url`);
  const prev = existsSync(urlPath) ? readFileSync(urlPath, 'utf-8').trim() : null;
  if (prev === url) {
    // Same URL, but an older run may have left a .skipped marker under this
    // id before the .url sidecar was rewritten. Seen 2026-11-26: a May
    // easyapply marker skipped Revin's Ashby posting. A marker is only valid
    // for an apply-only URL.
    const skipPath = join(JDS_DIR, `${id}.skipped`);
    if (!applyOnlyReason(url) && existsSync(skipPath)) {
      try { unlinkSync(skipPath); } catch { /* best effort */ }
    }
    return;
  }
  for (const ext of ['txt', 'url', 'location.json', 'skipped']) {
    const p = join(JDS_DIR, `${id}.${ext}`);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
}

for (const id of targetIds) {
  const url = urlById.get(id);
  if (!url) { results.skip.push(`${id} no-url`); continue; }

  clearStaleSidecars(id, url);

  const applyReason = applyOnlyReason(url);
  if (applyReason) {
    const markerPath = join(JDS_DIR, `${id}.skipped`);
    writeFileSync(markerPath, applyReason);
    // Sidecar URL so batch-runner's stale sweep can validate the marker too.
    writeFileSync(join(JDS_DIR, `${id}.url`), url);
    results.applyOnly.push(`${id} → ${markerPath} (${applyReason})`);
    continue;
  }

  try {
    let result = null;
    let m;
    // js-mj0: grnh.se is Greenhouse's link shortener. It redirects to the
    // real posting, often a company page with ?gh_jid= (grnh.se/323698c58us →
    // actively.ai/careers?gh_jid=4686122008). Match on the resolved URL. The
    // .url sidecar keeps the original so batch-runner's stale check still
    // compares like with like.
    let matchUrl = url;
    if (/^https?:\/\/grnh\.se\//i.test(url)) {
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (career-ops prefetch)' } });
        if (res.url) matchUrl = res.url;
      } catch { /* fall through with the short URL */ }
    }
    if ((m = matchUrl.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
      const slug = m[1];
      const jobId = m[2];
      result = await fetchAshby(slug, jobId);
    } else if ((m = matchUrl.match(/job-boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      result = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = matchUrl.match(/(?:boards|grnh\.se)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
      result = await fetchGreenhouse(m[1], m[2]);
    } else if ((m = matchUrl.match(/[?&]gh_jid=(\d+)/))) {
      // js-f7g: company careers proxy with gh_jid=. Try hostname-derived
      // slug first, fall back to sniffing the Greenhouse slug from any
      // embedded iframe / link in the page HTML.
      result = await fetchGreenhouseWithGhJid(matchUrl, m[1]);
    } else if ((m = matchUrl.match(/[?&]ashby_jid=([0-9a-f-]{36})/i))) {
      result = await fetchAshbyWithJid(matchUrl, m[1], companyById.get(id));
    } else if ((m = matchUrl.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
      result = await fetchLever(m[1], m[2]);
    } else if ((m = matchUrl.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i))) {
      // js-mj0: company-hosted Ashby boards often use the Ashby job UUID as
      // the path (tryprofound.com/careers/{uuid}). Try the slug guesses; if
      // none matches, treat the URL as unsupported (WebFetch fallback).
      try {
        result = await fetchAshbyWithJid(matchUrl, m[1], companyById.get(id));
      } catch {
        result = null;
      }
    }
    if (!result) {
      results.skip.push(`${id} unsupported url: ${url.slice(0,80)}`);
      continue;
    }
    const { text, location } = result;
    const path = join(JDS_DIR, `${id}.txt`);
    writeFileSync(path, text);
    // Sidecar URL marker — batch-runner.sh checks this to detect stale JDs
    // when batch-input.tsv changes the URL for an existing id (js-oe9).
    writeFileSync(join(JDS_DIR, `${id}.url`), url);
    // js-q4s: Sidecar location JSON — filter-batch-input.mjs reads this to
    // drop non-target-location rows using the ATS API as source of truth
    // rather than the LinkedIn-derived notes column (which is empty for
    // Mistral / Cohere / many other postings).
    writeFileSync(
      join(JDS_DIR, `${id}.location.json`),
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
