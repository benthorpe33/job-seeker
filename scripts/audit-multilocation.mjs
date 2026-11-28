#!/usr/bin/env node
// One-off audit: walk completed batch-state rows, re-hit each Ashby/Greenhouse
// API, and flag postings where secondary locations include NYC-area or US-remote
// but the primary location does not. These are the ones the prefetch bug
// (pre-js-XXX) plausibly mis-scored as "wrong city."
//
// Zero LLM tokens — pure HTTP + string match. Run after fixing prefetch-jds.mjs
// to surface candidates for re-evaluation.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NYC_RE = /\b(new york|nyc|manhattan|brooklyn)\b|, ny\b|\bny,/i;
const REMOTE_US_RE = /\bremote\b.*\b(us|usa|united states|north america)\b|\b(us|usa|united states|north america)\b.*\bremote\b|\bremote (- )?us\b/i;

// Walk every report on disk and harvest its (reportNum, url, score). This is
// broader than batch-state.tsv (which only covers the most recent batch run);
// older batches and manual /career-ops oferta runs leave reports without state
// rows.
const REPORTS_DIR = 'reports';
if (!existsSync(REPORTS_DIR)) {
  console.error(`Missing ${REPORTS_DIR}/`);
  process.exit(1);
}

const reportFiles = readdirSync(REPORTS_DIR).filter(f => /^\d+-.+\.md$/.test(f));
const rows = [];
for (const f of reportFiles) {
  const text = readFileSync(join(REPORTS_DIR, f), 'utf-8');
  const urlMatch = text.match(/\*\*URL:\*\*\s*(\S+)/i);
  if (!urlMatch) continue;
  const url = urlMatch[1].replace(/[·,]+$/, '');
  const reportNum = f.match(/^(\d+)/)[1];
  const scoreMatch = text.match(/\*\*Score:\*\*\s*([0-9.]+)/i);
  const score = scoreMatch ? scoreMatch[1] : '-';
  rows.push({ reportNum, url, score, file: f });
}

const ashbyBoards = new Map(); // slug -> { jobs: [...] } | { error }
async function getAshbyBoard(slug) {
  if (ashbyBoards.has(slug)) return ashbyBoards.get(slug);
  try {
    const r = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) {
      const v = { error: `HTTP ${r.status}` };
      ashbyBoards.set(slug, v);
      return v;
    }
    const json = await r.json();
    ashbyBoards.set(slug, json);
    return json;
  } catch (e) {
    const v = { error: e.message };
    ashbyBoards.set(slug, v);
    return v;
  }
}

async function checkAshby(slug, jobId) {
  const board = await getAshbyBoard(slug);
  if (board.error) return { error: board.error };
  const job = (board.jobs || []).find(x => x.id === jobId);
  if (!job) return { error: 'not in board (closed?)' };
  const primary = job.location || '';
  const secondary = (job.secondaryLocations || []).map(s => s?.location).filter(Boolean);
  return { primary, secondary, title: job.title };
}

async function checkGreenhouse(slug, jobId) {
  try {
    const r = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const primary = j.location?.name || '';
    const offices = (j.offices || []).map(o => o?.name).filter(Boolean);
    const secondary = offices.filter(n => n !== primary);
    return { primary, secondary, title: j.title };
  } catch (e) {
    return { error: e.message };
  }
}

const findings = [];
const skipped = { closed: 0, unsupported: 0, error: 0 };

for (const r of rows) {
  let m, info;
  if ((m = r.url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
    info = await checkAshby(m[1], m[2]);
  } else if (
    (m = r.url.match(/(?:job-boards|boards|grnh\.se)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))
  ) {
    info = await checkGreenhouse(m[1], m[2]);
  } else {
    skipped.unsupported++;
    continue;
  }

  if (info.error) {
    if (/not in board/.test(info.error)) skipped.closed++;
    else skipped.error++;
    continue;
  }
  if (!info.secondary || info.secondary.length === 0) continue;

  const primaryHasNyc = NYC_RE.test(info.primary);
  const secondaryHasNyc = info.secondary.some(s => NYC_RE.test(s));
  const primaryHasRemote = REMOTE_US_RE.test(info.primary);
  const secondaryHasRemote = info.secondary.some(s => REMOTE_US_RE.test(s));

  const flagNyc = !primaryHasNyc && secondaryHasNyc;
  const flagRemote = !primaryHasRemote && secondaryHasRemote;

  findings.push({ ...r, ...info, flagNyc, flagRemote });
}

const flagged = findings.filter(f => f.flagNyc || f.flagRemote);

console.log('=== Multi-location audit ===\n');
if (flagged.length === 0) {
  console.log('No flagged postings (no completed report has hidden NYC/Remote-US secondary location).');
} else {
  for (const f of flagged) {
    const tags = [];
    if (f.flagNyc) tags.push('NYC-hidden');
    if (f.flagRemote) tags.push('Remote-US-hidden');
    console.log(`⚠️  report=${f.reportNum} score=${f.score} [${tags.join(', ')}]`);
    console.log(`    title:     ${f.title}`);
    console.log(`    primary:   ${f.primary}`);
    console.log(`    secondary: ${f.secondary.join(' | ')}`);
    console.log(`    file:      reports/${f.file}`);
    console.log(`    url:       ${f.url}`);
    console.log('');
  }
}

console.log(
  `Scanned ${rows.length} reports · multi-location found: ${findings.length} · flagged: ${flagged.length}`,
);
console.log(
  `Skipped: closed=${skipped.closed} unsupported-ATS=${skipped.unsupported} error=${skipped.error}`,
);
