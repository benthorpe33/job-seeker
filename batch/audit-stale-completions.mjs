#!/usr/bin/env node
// Find rows in batch/batch-state.tsv marked status=completed where the
// referenced report file doesn't exist on disk. Optionally flip those rows
// to status=failed with retries=0 so `bash batch-runner.sh --retry-failed`
// will re-process them.
//
// Born from js-hjz cleanup: pre-fix runs left some rows lying about being
// completed when their workers actually exited 0 without writing the report.
//
// Usage:
//   node batch/audit-stale-completions.mjs            # dry run, list offenders
//   node batch/audit-stale-completions.mjs --apply    # rewrite state.tsv

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '..');
const STATE_FILE = join(__dirname, 'batch-state.tsv');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

const APPLY = process.argv.includes('--apply');

if (!existsSync(STATE_FILE)) {
  console.error(`batch-state.tsv not found at ${STATE_FILE}`);
  process.exit(1);
}

const raw = readFileSync(STATE_FILE, 'utf-8');
const lines = raw.split(/\r?\n/);
const header = lines[0];
const expected =
  'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries';
if (header !== expected) {
  console.error(`Unexpected header. Got:\n  ${header}\nExpected:\n  ${expected}`);
  process.exit(2);
}

const reportFiles = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR) : [];

function reportExists(reportNum) {
  if (!reportNum || reportNum === '-') return false;
  const padded = String(reportNum).padStart(3, '0');
  return reportFiles.some((f) => f.startsWith(`${padded}-`) && f.endsWith('.md'));
}

const offenders = [];
const out = [header];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) {
    out.push(line);
    continue;
  }
  const cols = line.split('\t');
  if (cols.length < 9) {
    out.push(line);
    continue;
  }
  const [id, url, status, started, completed, reportNum, score, error, retries] = cols;
  if (status === 'completed' && !reportExists(reportNum)) {
    offenders.push({ id, reportNum, score, url });
    if (APPLY) {
      const newError = `js-hjz audit: stale completion — no report file at reports/${reportNum}-*.md`;
      out.push(
        [
          id,
          url,
          'failed',
          started,
          completed,
          reportNum,
          score,
          newError,
          '0',
        ].join('\t'),
      );
      continue;
    }
  }
  out.push(line);
}

if (offenders.length === 0) {
  console.log('✅ No stale completions found.');
  process.exit(0);
}

console.log(`Found ${offenders.length} stale completion(s):`);
for (const o of offenders) {
  console.log(
    `  id=${o.id} report=${o.reportNum} score=${o.score} url=${o.url}`,
  );
}

if (!APPLY) {
  console.log('\n(dry run) Re-run with --apply to flip these rows to failed with retries=0.');
  process.exit(0);
}

writeFileSync(STATE_FILE, out.join('\n'), 'utf-8');
console.log(`\n✏️  Rewrote ${STATE_FILE} — ${offenders.length} row(s) flipped to failed.`);
console.log('   Run `bash batch/batch-runner.sh --retry-failed` to re-process them.');
