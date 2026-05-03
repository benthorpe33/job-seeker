#!/usr/bin/env node
// One-shot backfill: derive data/rejection-feedback.tsv from existing
// SKIP/Discarded rows in data/applications.md so the T10 aggregator (js-70e)
// has a corpus before the live UI flow accumulates one. Mirrors the writer in
// app/server/src/api/rejections.ts so the file is byte-compatible going forward.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const APPS = join(ROOT, 'data', 'applications.md');
const OUT = join(ROOT, 'data', 'rejection-feedback.tsv');
const HEADER = 'ts\tapplication_id\tcompany\trole\tscore\treason';
const FORCE = process.argv.includes('--force');

if (existsSync(OUT)) {
  const lines = readFileSync(OUT, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length > 1 && !FORCE) {
    console.error(
      `${OUT} already has data (${lines.length - 1} rows) — refusing to backfill. Use --force to override.`,
    );
    process.exit(1);
  }
}

const ts = statSync(APPS).mtime.toISOString();
const rows = [];

for (const line of readFileSync(APPS, 'utf8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const cols = line.split('|').slice(1, -1).map((s) => s.trim());
  if (cols.length < 9) continue;
  const [num, , company, role, scoreRaw, status, , , notes] = cols;
  if (status !== 'SKIP' && status !== 'Discarded') continue;
  if (!/^\d+$/.test(num)) continue;
  const reason = notes.replace(/[\t\r\n]+/g, ' ').trim();
  if (!reason) continue;
  let score = '';
  if (scoreRaw && scoreRaw !== '-') {
    const parsed = parseFloat(scoreRaw.replace(/\/5$/, ''));
    if (!Number.isNaN(parsed)) score = parsed.toFixed(1);
  }
  rows.push([ts, num, company, role, score, reason].join('\t'));
}

writeFileSync(OUT, [HEADER, ...rows, ''].join('\n'));
console.log(`Wrote ${rows.length} rows to ${OUT}`);
