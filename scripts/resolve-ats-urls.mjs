#!/usr/bin/env node
// Resolve LinkedIn job IDs to external ATS apply URLs using the persisted auth session.
//
// Reads:  data/linkedin-saved-jobs.json
//         data/applications.md  (to dedup against already-evaluated company+role pairs)
// Writes: data/linkedin-resolved.json  (full resolution result for review)
//
// Strategy: for each job, navigate to /jobs/view/{id}/, find the Apply button.
//   - The "Apply on company website" button is an <a> whose href is
//     https://www.linkedin.com/safety/go/?url=<URL-encoded ATS URL>&urlhash=...
//     We URL-decode the `url` query param to get the real ATS apply URL.
//   - "Easy Apply" buttons stay on linkedin.com → mark easyApply=true and skip.
//
// Manual-trigger only. Run AFTER scripts/linkedin-saved-jobs.mjs.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUTH_FILE = resolve(REPO_ROOT, 'data', '.linkedin-auth.json');
const INPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-saved-jobs.json');
const OUTPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-resolved.json');
const APPS_FILE = resolve(REPO_ROOT, 'data', 'applications.md');

const args = new Set(process.argv.slice(2));
const HEADFUL = args.has('--headful');
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeCompany(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normalizeRole(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseApplications(md) {
  // Returns Set of normalized "company||role" keys for fuzzy dedup.
  const lines = md.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !/\|\s*#\s*\|/.test(l));
  const keys = new Set();
  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim());
    // Format: | # | Date | Company | Role | Score | Status | ...
    if (cells.length < 5) continue;
    const company = cells[3];
    const role = cells[4];
    if (!company || !role) continue;
    keys.add(normalizeCompany(company) + '||' + normalizeRole(role));
  }
  return keys;
}

function looksLikeAlreadyEvaluated(job, appKeys) {
  const company = job.cardText?.[1] || '';
  const role = job.cardText?.[0] || job.title || '';
  const cn = normalizeCompany(company);
  const rn = normalizeRole(role);
  if (!cn || !rn) return false;
  const key = cn + '||' + rn;
  if (appKeys.has(key)) return true;
  // Fuzzier: same company + ≥3 shared non-stopword tokens in role
  const stop = new Set(['senior', 'staff', 'principal', 'lead', 'engineer', 'scientist', 'data', 'ai', 'ml', 'forward', 'deployed', 'applied', 'solutions', 'architect', 'analyst', 'developer', 'software', 'technical', 'member']);
  const myTokens = new Set(rn.split(' ').filter((t) => t.length > 2 && !stop.has(t)));
  for (const k of appKeys) {
    const [kc, kr] = k.split('||');
    if (kc !== cn) continue;
    const theirTokens = new Set(kr.split(' ').filter((t) => t.length > 2 && !stop.has(t)));
    let shared = 0;
    for (const t of myTokens) if (theirTokens.has(t)) shared++;
    if (shared >= 3) return true;
  }
  return false;
}

async function resolveOne(context, job) {
  const page = await context.newPage();
  const result = {
    jobId: job.jobId,
    title: job.cardText?.[0] || job.title || '',
    company: job.cardText?.[1] || '',
    location: job.cardText?.[2] || '',
    listUrl: job.listUrl,
    applyUrl: null,
    applyKind: null, // 'easyApply' | 'offsite' | 'closed' | 'unknown'
    error: null,
  };

  try {
    await page.goto(`https://www.linkedin.com/jobs/view/${job.jobId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500 + Math.floor(Math.random() * 800));

    // Detect closed jobs
    const closedText = await page.locator('text=/no longer accepting applications|job is closed/i').count().catch(() => 0);
    if (closedText > 0) {
      result.applyKind = 'closed';
      await page.close();
      return result;
    }

    // Find Apply controls. The offsite variant is an <a aria-label="Apply on company website">
    // whose href is https://www.linkedin.com/safety/go/?url=<encoded ATS URL>&urlhash=...
    // The Easy Apply variant is a <button aria-label*="Easy Apply"> that stays on linkedin.com.
    const found = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button'));
      for (const el of els) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt = (el.innerText || '').toLowerCase();
        if (/easy apply/.test(al) || /easy apply/.test(txt)) {
          return { kind: 'easyApply', href: null };
        }
        if (/apply on company website/.test(al) || (/^apply$/.test(txt.trim()) && el.tagName === 'A' && el.href.includes('/safety/go/'))) {
          return { kind: 'offsite', href: el.href };
        }
      }
      // Fallback: any <a> whose href is /safety/go/?url=...
      for (const a of document.querySelectorAll('a[href*="/safety/go/"]')) {
        return { kind: 'offsite', href: a.href };
      }
      return { kind: 'unknown', href: null };
    });

    if (found.kind === 'easyApply') {
      result.applyKind = 'easyApply';
    } else if (found.kind === 'offsite' && found.href) {
      // Decode the &url=... query param. Note LinkedIn URL-encodes dots as %2E too.
      try {
        const u = new URL(found.href);
        const target = u.searchParams.get('url');
        if (target) {
          result.applyUrl = decodeURIComponent(target);
          result.applyKind = 'offsite';
        } else {
          result.applyKind = 'unknown';
          result.error = 'safety/go href had no url param';
        }
      } catch (e) {
        result.applyKind = 'unknown';
        result.error = 'failed to parse href: ' + String(e.message).slice(0, 80);
      }
    } else {
      result.applyKind = 'unknown';
      result.error = 'no apply control found';
    }
  } catch (e) {
    result.error = String(e.message || e).slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
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
  const appKeys = parseApplications(appsMd);
  console.log(`[resolve] loaded ${input.jobs.length} jobs, ${appKeys.size} prior applications for dedup`);

  // Pre-filter: drop already-evaluated
  const candidates = [];
  const skipped = [];
  for (const j of input.jobs) {
    if (looksLikeAlreadyEvaluated(j, appKeys)) {
      skipped.push({ jobId: j.jobId, title: j.cardText?.[0], company: j.cardText?.[1], reason: 'already in applications.md' });
    } else {
      candidates.push(j);
    }
  }
  console.log(`[resolve] ${candidates.length} candidates after dedup (${skipped.length} skipped as already-evaluated)`);

  const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  console.log(`[resolve] resolving ${todo.length} jobs${LIMIT ? ` (--limit=${LIMIT})` : ''}`);

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

  const resolved = [];
  for (let i = 0; i < todo.length; i++) {
    const job = todo[i];
    const r = await resolveOne(context, job);
    resolved.push(r);
    const tag = r.applyKind === 'offsite' ? '✓' : r.applyKind === 'easyApply' ? '~' : r.applyKind === 'closed' ? '✗' : '?';
    console.log(`[${i + 1}/${todo.length}] ${tag} ${r.company} — ${r.title} → ${r.applyKind}${r.applyUrl ? ' ' + r.applyUrl.slice(0, 80) : ''}${r.error ? ' err=' + r.error : ''}`);
    await sleep(1000 + Math.floor(Math.random() * 1500)); // jittered politeness delay
  }

  const out = {
    resolvedAt: new Date().toISOString(),
    inputCount: input.jobs.length,
    skippedAsEvaluated: skipped,
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
  await browser.close();
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
