#!/usr/bin/env node
// One-off: apply 5 manual re-evaluations (reports 351-355) to applications.md.
// Relink existing rows where present, add a new row where not. Delete the old
// report files that are now superseded.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

const ops = [
  {
    rowNum: 79,
    oldFile: 'reports/061-rillet-2026-04-28.md',
    oldLink: '[061](reports/061-rillet-2026-04-28.md)',
    newLink: '[351](reports/351-rillet-2026-05-04.md)',
    newScore: '4.2',
  },
  {
    rowNum: 82,
    oldFile: 'reports/064-baseten-ai-solutions-engineer-2026-04-28.md',
    oldLink: '[064](reports/064-baseten-ai-solutions-engineer-2026-04-28.md)',
    newLink: '[352](reports/352-baseten-2026-05-04.md)',
    newScore: '4.6',
  },
  {
    rowNum: 87,
    oldFile: 'reports/069-cohere-applied-ai-agentic-2026-04-28.md',
    oldLink: '[069](reports/069-cohere-applied-ai-agentic-2026-04-28.md)',
    newLink: '[353](reports/353-cohere-2026-05-04.md)',
    newScore: '3.1',
  },
  {
    rowNum: 156,
    oldFile: 'reports/280-brellium-2026-05-03.md',
    oldLink: '[280](reports/280-brellium-2026-05-03.md)',
    newLink: '[355](reports/355-brellium-2026-05-04.md)',
    newScore: '3.7',
  },
];

const newRow = '| 175 | 2026-05-04 | Ramp | Software Engineer, AI Forward Deployed | 4.3/5 | Evaluated | ❌ | [354](reports/354-ramp-2026-05-04.md) | NYC HQ + SF dual-office (corrected — original eval missed NYC secondary location); $168K–$280K + equity; FDE archetype primary; ZS hybrid-deterministic-LLM wedge fits Ramp\'s agent-reliability ask; fintech is domain ramp; APPLY |';
const ramp333File = 'reports/333-ramp-2026-05-04.md';

const apps = readFileSync('data/applications.md', 'utf-8');
const lines = apps.split('\n');
const out = [];
const updated = new Set();

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  for (const op of ops) {
    if (line.includes(op.oldLink)) {
      const cols = line.split('|');
      cols[5] = ` ${op.newScore}/5 `;
      line = cols.join('|').replace(op.oldLink, op.newLink);
      console.log(`  relink row ${op.rowNum}: ${op.oldLink} → ${op.newLink} (score ${op.newScore})`);
      updated.add(op.rowNum);
      break;
    }
  }
  out.push(line);
}

// Append the Ramp FDE row (no existing row to relink).
// Find the last data row and insert after it, before any trailing blank/EOF.
let insertIdx = out.length;
for (let i = out.length - 1; i >= 0; i--) {
  if (/^\|\s*\d+\s*\|/.test(out[i])) { insertIdx = i + 1; break; }
}
out.splice(insertIdx, 0, newRow);
console.log(`  add row 175 (Ramp FDE) → [354]`);

writeFileSync('data/applications.md', out.join('\n'));

// Delete the old superseded reports.
for (const op of ops) {
  if (existsSync(op.oldFile)) { unlinkSync(op.oldFile); console.log(`  rm ${op.oldFile}`); }
}
if (existsSync(ramp333File)) { unlinkSync(ramp333File); console.log(`  rm ${ramp333File}`); }

console.log(`\nUpdated ${updated.size} rows, added 1 row, deleted ${ops.length + 1} old reports.`);
