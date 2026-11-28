#!/usr/bin/env node
// Fix broken applications.md links after the dedup + supersede operations.
// applications.md was restored from .bak; reports were already deleted on disk.
// For each broken link in applications.md, replace it with the keeper's link
// (and update the score column where the supersede materially changed it).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

// loserNum → { keeperNum, keeperFile, scoreOverride? }
// scoreOverride is set only for the 4 supersedes where the new eval differs
// materially from the old (and the row's score column should reflect the new
// canonical eval).
const map = {
  // Dedup pass 1 (28 dups)
  '008': { keeperNum: 17 },
  '098': { keeperNum: 102 },
  '100': { keeperNum: 103 },
  '160': { keeperNum: 278 },
  '166': { keeperNum: 264 },
  '167': { keeperNum: 265 },
  '168': { keeperNum: 266 },
  '170': { keeperNum: 268 },
  '174': { keeperNum: 272 },
  '183': { keeperNum: 281 },
  '185': { keeperNum: 283 },
  '188': { keeperNum: 286 },
  '190': { keeperNum: 288 },
  '195': { keeperNum: 293 },
  '198': { keeperNum: 296 },
  '203': { keeperNum: 300 },
  '204': { keeperNum: 301 },
  '206': { keeperNum: 303 },
  '207': { keeperNum: 304 },
  '212': { keeperNum: 309 },
  '218': { keeperNum: 312 },
  '219': { keeperNum: 313 },
  '220': { keeperNum: 314 },
  '221': { keeperNum: 315 },
  '222': { keeperNum: 316 },
  '229': { keeperNum: 261 },
  '244': { keeperNum: 306 },
  '247': { keeperNum: 310 },
  // Dedup pass 2 (after URL fixes, 2 more)
  '228': { keeperNum: 280 },
  '165': { keeperNum: 295 },
  // Supersedes (4)
  '046': { keeperNum: 338, scoreOverride: '2.6' },
  '057': { keeperNum: 346, scoreOverride: '1.8' },
  '155': { keeperNum: 341, scoreOverride: '4.6' },
  '146': { keeperNum: 350, scoreOverride: '2.4' },
};

// Resolve keeperFile by scanning reports/.
const reportFiles = readdirSync('reports').filter(f => /^\d+-.+\.md$/.test(f));
for (const [loser, info] of Object.entries(map)) {
  const padded = String(info.keeperNum).padStart(3, '0');
  const file = reportFiles.find(f => f.startsWith(padded + '-'));
  if (!file) {
    console.error(`MISSING keeper file for #${info.keeperNum} (loser was ${loser})`);
    process.exit(1);
  }
  info.keeperFile = file;
}

const apps = readFileSync('data/applications.md', 'utf-8');
const lines = apps.split('\n');
const out = [];
let updated = 0;
let dropped = 0;

// Track keeperNums that already have a row pre-existing — for the supersede
// case, we want to DROP the new-batch row (e.g. row #178 Moment 4.6) since
// the existing row will be relinked to it. But this is only relevant for
// row #178 (the Moment new entry); other supersedes' new evals never made
// it into applications.md (merge-tracker skipped them).
const dropRowNums = new Set(['178']);

for (const line of lines) {
  // Drop pre-flagged duplicate rows (Moment 178 added by merge-tracker)
  // Match the row's first-column number (between leading "| " and " |")
  const rowNumMatch = line.match(/^\|\s*(\d+)\s*\|/);
  if (rowNumMatch && dropRowNums.has(rowNumMatch[1])) {
    console.log(`  drop row #${rowNumMatch[1]}`);
    dropped++;
    continue;
  }

  // Find a [NNN](reports/NNN-...) link in the line.
  const linkMatch = line.match(/\[(\d+)\]\(reports\/(\d+)-([^)]+\.md)\)/);
  if (!linkMatch) { out.push(line); continue; }

  const linkedNum = linkMatch[2];
  const action = map[linkedNum];
  if (!action) { out.push(line); continue; }

  const newPad = String(action.keeperNum).padStart(3, '0');
  const newLink = `[${newPad}](reports/${action.keeperFile})`;
  let newLine = line.replace(linkMatch[0], newLink);

  if (action.scoreOverride) {
    // Score is the 5th |-separated field (index 5 in the split where index 0
    // is the empty prefix before the leading "|"):
    //   "| # | Date | Company | Role | Score | Status | PDF | [link] | Notes |"
    //    0   1     2      3        4     5       6        7    8        9
    const cols = newLine.split('|');
    if (cols.length >= 7) {
      cols[5] = ` ${action.scoreOverride}/5 `;
      newLine = cols.join('|');
    }
  }

  console.log(`  relink #${rowNumMatch?.[1] ?? '?'}: [${linkedNum}] → [${newPad}]${action.scoreOverride ? ` (score → ${action.scoreOverride})` : ''}`);
  out.push(newLine);
  updated++;
}

writeFileSync('data/applications.md', out.join('\n'));
console.log(`\nDone. Updated ${updated} rows, dropped ${dropped} rows.`);
