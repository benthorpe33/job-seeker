#!/usr/bin/env node
// Resolve LinkedIn job IDs to external ATS apply URLs using the persisted auth session.
//
// Reads:  data/linkedin-saved-jobs.json
//         data/applications.md  (to dedup against already-evaluated company+role pairs)
// Writes: data/linkedin-resolved.json  (full resolution result for review)
//
// Strategy, per job, first source that gives a definite answer wins. None of
// them click Apply (a click is recorded by LinkedIn as an apply intent).
//   1. Voyager API  GET /voyager/api/jobs/jobPostings/{id}
//        applyMethod.$type OffsiteApply → companyApplyUrl
//        applyMethod.$type *OnsiteApply → Easy Apply (skip)
//        closedAt / jobState CLOSED     → closed
//   2. Raw HTML of /jobs/view/{id}/ — the server-driven UI payload embeds
//      "offsiteApplyUrl" / "isOnsiteApply" (the rendered Apply control is a
//      <button> with no href since 2026-09, so the DOM alone can't give the URL).
//   3. Legacy DOM scan: Easy Apply button, or an <a> to /safety/go/?url=<ATS URL>.
//
// Exits 6 (after writing output) when too many fresh resolutions fail, so the
// app pipeline halts instead of silently dropping jobs at Stage 3.
//
// Manual-trigger only. Run AFTER scripts/linkedin-saved-jobs.mjs.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUrl, loadEvaluatedUrls } from './lib/reports-urls.mjs';
import { parseApplicationsRows, looksLikeDuplicate } from './lib/dedup.mjs';
import { savedJobFields } from './lib/linkedin-card.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUTH_FILE = resolve(REPO_ROOT, 'data', '.linkedin-auth.json');
const INPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-saved-jobs.json');
const OUTPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-resolved.json');
const CACHE_FILE = resolve(REPO_ROOT, 'data', 'linkedin-resolved-cache.json');
const APPS_FILE = resolve(REPO_ROOT, 'data', 'applications.md');
const DEFAULT_CACHE_TTL_DAYS = 30;
const CACHE_FLUSH_EVERY = 10;
// Fail the stage when more than this share of fresh lookups end unresolved
// (and at least MIN_FAILURES_TO_FAIL did, so one odd posting doesn't halt a run).
const MAX_FAIL_RATE = 0.25;
const MIN_FAILURES_TO_FAIL = 2;

const args = new Set(process.argv.slice(2));
const HEADFUL = args.has('--headful');
const NO_CACHE = args.has('--no-cache');
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const CACHE_TTL_DAYS = (() => {
  const a = process.argv.find((x) => x.startsWith('--cache-ttl-days='));
  if (!a) return DEFAULT_CACHE_TTL_DAYS;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_DAYS;
})();

function loadCache() {
  if (NO_CACHE || !existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn(`[cache] failed to read ${CACHE_FILE}: ${e.message} — treating as empty`);
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function isCacheHit(entry) {
  if (!entry) return false;
  if (!entry.applyKind || entry.applyKind === 'unknown') return false;
  if (entry.error) return false;
  if (!entry.resolvedAt) return false;
  const ts = Date.parse(entry.resolvedAt);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs < CACHE_TTL_DAYS * 86400_000;
}

function cacheToResult(jobId, job, entry) {
  return {
    jobId,
    ...savedJobFields(job),
    listUrl: job.listUrl,
    applyUrl: entry.applyUrl ?? null,
    applyKind: entry.applyKind,
    error: entry.error ?? null,
    fromCache: true,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e) {
  return String(e?.message || e).slice(0, 160);
}

// Unwrap https://www.linkedin.com/safety/go/?url=<encoded ATS URL>&urlhash=...
// Non-wrapped URLs pass through; returns null when nothing usable is left.
function unwrapSafetyGo(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)linkedin\.com$/.test(u.hostname) && u.pathname.startsWith('/safety/go')) {
      return u.searchParams.get('url') || null; // searchParams already percent-decodes
    }
    return href;
  } catch {
    return null;
  }
}

async function csrfToken(context) {
  const cookies = await context.cookies('https://www.linkedin.com');
  return (cookies.find((c) => c.name === 'JSESSIONID')?.value || '').replace(/"/g, '');
}

// Source 1. Returns { kind, applyUrl? } on a definite answer, else { error }.
async function fromVoyager(context, csrf, jobId) {
  const res = await context.request.get(`https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`, {
    headers: {
      'csrf-token': csrf,
      'x-restli-protocol-version': '2.0.0',
      accept: 'application/vnd.linkedin.normalized+json+2.1',
    },
    timeout: 30000,
  });
  if (!res.ok()) return { error: `voyager HTTP ${res.status()}` };
  let data;
  try {
    data = (await res.json())?.data;
  } catch {
    return { error: 'voyager returned non-JSON' };
  }
  if (!data) return { error: 'voyager returned no data' };
  if (data.closedAt || /CLOSED|EXPIRED/i.test(data.jobState || '')) return { kind: 'closed' };
  const am = data.applyMethod || {};
  const type = am.$type || '';
  if (/OffsiteApply$/.test(type)) {
    const applyUrl = am.companyApplyUrl ? unwrapSafetyGo(am.companyApplyUrl) : null;
    return applyUrl ? { kind: 'offsite', applyUrl } : { error: 'voyager OffsiteApply without companyApplyUrl' };
  }
  if (/OnsiteApply$/.test(type) || am.easyApplyUrl) return { kind: 'easyApply' };
  return { error: `voyager applyMethod ${type || 'missing'}` };
}

// Source 2. The job page's raw HTML carries a JSON-escaped SDUI payload like
//   \"payload\":{\"jobId\":\"4381276550\",\"companyName\":\"Snorkel AI\",\"isOnsiteApply\":false,
//                \"offsiteApplyUrl\":\"https://job-boards.greenhouse.io/...\", ...}
// Easy Apply postings backed by an ATS carry an offsiteApplyUrl too, so
// isOnsiteApply decides. jobId appears in many unrelated payloads, so anchor on
// each isOnsiteApply and require this jobId just before it (the page can embed
// other postings).
function fromJobPageHtml(html, jobId) {
  const idRe = new RegExp(`jobId\\\\*"\\s*:\\s*\\\\*"${jobId}\\\\*"`);
  const urlRe = /offsiteApplyUrl\\*"\s*:\s*\\*"((?:[^"\\]|\\u[0-9a-fA-F]{4}|\\\/)+)/;
  for (const m of html.matchAll(/isOnsiteApply\\*"\s*:\s*(true|false)/g)) {
    if (!idRe.test(html.slice(Math.max(0, m.index - 400), m.index))) continue;
    if (m[1] === 'true') return { kind: 'easyApply' };
    const u = html.slice(m.index, m.index + 1500).match(urlRe);
    if (!u) continue;
    const raw = u[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/');
    const applyUrl = unwrapSafetyGo(raw);
    if (applyUrl) return { kind: 'offsite', applyUrl };
  }
  return null;
}

async function resolveOne(context, csrf, job) {
  const result = {
    jobId: job.jobId,
    ...savedJobFields(job),
    listUrl: job.listUrl,
    applyUrl: null,
    applyKind: null, // 'easyApply' | 'offsite' | 'closed' | 'unknown'
    error: null,
    via: null, // 'voyager' | 'html' | 'dom'
  };
  const settle = (found, via) => {
    result.applyKind = found.kind;
    result.applyUrl = found.applyUrl ?? null;
    result.via = via;
    return result;
  };
  const errors = [];

  try {
    const v = await fromVoyager(context, csrf, job.jobId);
    if (v.kind) return settle(v, 'voyager');
    errors.push(v.error);
  } catch (e) {
    errors.push(`voyager: ${errMsg(e)}`);
  }

  const page = await context.newPage();
  try {
    const resp = await page.goto(`https://www.linkedin.com/jobs/view/${job.jobId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = resp ? await resp.text().catch(() => '') : '';
    await sleep(1500 + Math.floor(Math.random() * 800));

    const closedText = await page.locator('text=/no longer accepting applications|job is closed/i').count().catch(() => 0);
    if (closedText > 0) return settle({ kind: 'closed' }, 'dom');

    const h = fromJobPageHtml(html, job.jobId);
    if (h) return settle(h, 'html');

    // Source 3: legacy DOM, where offsite Apply was an <a> to /safety/go/.
    // Only consider apply-labelled controls — the page chrome has other
    // /safety/go/ links (feed promos, company sites) that aren't ATS URLs.
    const found = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, button')) {
        const label = `${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`.toLowerCase();
        // Buttons only: recommended-job cards (<a>) also show an "Easy Apply" badge.
        if (el.tagName === 'BUTTON' && /easy apply/.test(label)) return { kind: 'easyApply', href: null };
        if (/\bapply\b/.test(label) && el.tagName === 'A' && el.href.includes('/safety/go/')) {
          return { kind: 'offsite', href: el.href };
        }
      }
      return null;
    });
    if (found?.kind === 'easyApply') return settle(found, 'dom');
    if (found?.href) {
      const applyUrl = unwrapSafetyGo(found.href);
      if (applyUrl) return settle({ kind: 'offsite', applyUrl }, 'dom');
    }
    errors.push('page: no apply URL in HTML or DOM');
  } catch (e) {
    errors.push(`page: ${errMsg(e)}`);
  } finally {
    await page.close().catch(() => {});
  }

  result.applyKind = 'unknown';
  result.error = errors.join('; ');
  return result;
}

(async () => {
  if (!existsSync(AUTH_FILE)) {
    console.error(`no auth file at ${AUTH_FILE} — run scripts/linkedin-saved-jobs.mjs --login first`);
    process.exit(1);
  }
  if (!existsSync(INPUT_FILE)) {
    console.error(`no input at ${INPUT_FILE} — run scripts/linkedin-saved-jobs.mjs first`);
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(INPUT_FILE, 'utf8'));
  const appsMd = existsSync(APPS_FILE) ? readFileSync(APPS_FILE, 'utf8') : '';
  const apps = parseApplicationsRows(appsMd);
  console.log(`[resolve] loaded ${input.jobs.length} jobs, ${apps.length} prior applications for dedup`);

  // Pre-filter: drop already-evaluated
  const candidates = [];
  const skipped = [];
  for (const j of input.jobs) {
    const { company, title: role } = savedJobFields(j);
    if (apps.some((a) => looksLikeDuplicate({ company, role }, a, { threshold: 3 }))) {
      skipped.push({ jobId: j.jobId, title: role, company, reason: 'already in applications.md' });
    } else {
      candidates.push(j);
    }
  }
  console.log(`[resolve] ${candidates.length} candidates after dedup (${skipped.length} skipped as already-evaluated)`);

  // Partition candidates by cache state. Cached hits skip Playwright entirely.
  const cache = loadCache();
  const cachedResults = [];
  const uncached = [];
  for (const j of candidates) {
    const entry = cache[j.jobId];
    if (isCacheHit(entry)) {
      cachedResults.push(cacheToResult(j.jobId, j, entry));
    } else {
      uncached.push(j);
    }
  }
  console.log(`[resolve] cache: ${cachedResults.length} hits, ${uncached.length} to resolve (TTL=${CACHE_TTL_DAYS}d${NO_CACHE ? ', --no-cache' : ''})`);

  // Hoist the URL-vs-reports/ dedup that filter-batch-input.mjs does at Stage
  // 5: any cached offsite URL already in a report is dropped here so we never
  // surface it to append-to-pipeline.mjs (which would re-add it to the
  // pipeline inbox). Stage 5 stays as a backstop for first-run / non-cached
  // jobs whose ATS URL we only learn from this run's Playwright resolves.
  const evaluatedReportUrls = loadEvaluatedUrls();
  const cachedFresh = [];
  let alreadyReportedCount = 0;
  for (const r of cachedResults) {
    if (r.applyKind === 'offsite' && r.applyUrl && evaluatedReportUrls.has(normalizeUrl(r.applyUrl))) {
      alreadyReportedCount += 1;
      continue;
    }
    cachedFresh.push(r);
  }
  if (alreadyReportedCount > 0) {
    console.log(`[resolve] ${alreadyReportedCount} cached jobs already in reports/, skipping`);
  }

  const todo = LIMIT ? uncached.slice(0, LIMIT) : uncached;
  console.log(`[resolve] resolving ${todo.length} jobs${LIMIT ? ` (--limit=${LIMIT})` : ''}`);

  const fresh = [];

  if (todo.length > 0) {
    const browser = await chromium.launch({ headless: !HEADFUL });
    const context = await browser.newContext({ storageState: AUTH_FILE });
    // One quick auth check
    const probe = await context.newPage();
    await probe.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (/\/login|\/checkpoint/.test(probe.url())) {
      console.error('[resolve] session expired — re-run linkedin-saved-jobs.mjs --login');
      await browser.close();
      process.exit(2);
    }
    await probe.close();
    // The feed load above refreshes JSESSIONID; the copy in the auth file can be
    // stale and Voyager rejects a stale token with "CSRF check failed".
    const csrf = await csrfToken(context);

    for (let i = 0; i < todo.length; i++) {
      const job = todo[i];
      const r = await resolveOne(context, csrf, job);
      fresh.push(r);
      // Upsert into cache. Even error/unknown rows are written so a follow-up
      // run with stale cache logic doesn't pretend it's a hit; isCacheHit()
      // filters them on read.
      cache[r.jobId] = {
        applyUrl: r.applyUrl ?? null,
        applyKind: r.applyKind,
        error: r.error ?? null,
        resolvedAt: new Date().toISOString(),
      };
      const tag = r.applyKind === 'offsite' ? '✓' : r.applyKind === 'easyApply' ? '~' : r.applyKind === 'closed' ? '✗' : '?';
      console.log(`[${i + 1}/${todo.length}] ${tag} ${r.company} — ${r.title} → ${r.applyKind}${r.via ? ` (via ${r.via})` : ''}${r.applyUrl ? ' ' + r.applyUrl.slice(0, 80) : ''}${r.error ? ' err=' + r.error : ''}`);
      // Flush periodically so a crash mid-loop preserves progress.
      if (!NO_CACHE && (i + 1) % CACHE_FLUSH_EVERY === 0) {
        try { saveCache(cache); } catch (e) { console.warn(`[cache] flush failed: ${e.message}`); }
      }
      await sleep(1000 + Math.floor(Math.random() * 1500)); // jittered politeness delay
    }
    await browser.close();
  }

  // Final cache flush (covers tail rows since last periodic flush, plus the
  // todo.length === 0 case where we still want the file to exist).
  if (!NO_CACHE) {
    try { saveCache(cache); } catch (e) { console.warn(`[cache] final flush failed: ${e.message}`); }
  }

  const resolved = [...cachedFresh, ...fresh];
  const out = {
    resolvedAt: new Date().toISOString(),
    inputCount: input.jobs.length,
    skippedAsEvaluated: skipped,
    cacheHits: cachedResults.length,
    alreadyReported: alreadyReportedCount,
    resolved,
    summary: {
      offsite: resolved.filter((r) => r.applyKind === 'offsite').length,
      easyApply: resolved.filter((r) => r.applyKind === 'easyApply').length,
      closed: resolved.filter((r) => r.applyKind === 'closed').length,
      unknown: resolved.filter((r) => r.applyKind === 'unknown' || r.applyKind === null).length,
    },
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n[resolve] summary:`, out.summary);
  console.log(`[resolve] wrote → ${OUTPUT_FILE}`);
  console.log(`[resolve] next: review the file, then I'll append offsite URLs to data/pipeline.md after your OK`);

  // Unresolved jobs are dropped at Stage 3, so a lookup regression (e.g. a
  // LinkedIn layout change) must fail the stage rather than pass quietly.
  // Output and cache are already written, so a re-run only retries failures.
  const failed = fresh.filter((r) => r.applyKind === 'unknown' || !r.applyKind);
  if (failed.length > 0) {
    for (const r of failed) console.error(`[resolve]   unresolved ${r.jobId} ${r.company} — ${r.title}: ${r.error}`);
    const tooMany =
      failed.length >= Math.min(MIN_FAILURES_TO_FAIL, fresh.length) &&
      failed.length / fresh.length > MAX_FAIL_RATE;
    if (tooMany) {
      console.error(`[resolve] ${failed.length}/${fresh.length} fresh lookups unresolved — LinkedIn may have changed; see errors above`);
      process.exit(6);
    }
    console.error(`[resolve] WARNING: ${failed.length}/${fresh.length} fresh lookups unresolved; they will not reach pipeline.md`);
  }
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
