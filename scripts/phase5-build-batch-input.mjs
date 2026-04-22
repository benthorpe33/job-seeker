#!/usr/bin/env node
// Convert data/pipeline-top50.md → batch/batch-input.tsv
// TSV columns: id, url, source, notes

import { readFileSync, writeFileSync } from 'node:fs';

const PIPELINE = 'data/pipeline-top50.md';
const OUT = 'batch/batch-input.tsv';

const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
const rows = ['id\turl\tsource\tnotes'];

let id = 1;
for (const line of lines) {
  const m = line.match(/^- \[ \] (https?:\/\/\S+) \| ([^|]+) \| ([^|]+)(?:\s*\|\s*(.+))?$/);
  if (!m) continue;
  const url = m[1];
  const company = m[2].trim();
  const role = m[3].trim();
  const loc = (m[4] || '').trim();
  // Source inferred from URL host for Greenhouse/Ashby/Lever
  let source = 'Scan';
  if (url.includes('greenhouse.io')) source = 'Greenhouse';
  else if (url.includes('ashbyhq.com')) source = 'Ashby';
  else if (url.includes('lever.co')) source = 'Lever';
  const notes = `${company} | ${role}${loc ? ' | ' + loc : ''}`;
  rows.push(`${id}\t${url}\t${source}\t${notes}`);
  id++;
}

writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`Wrote ${OUT} with ${id - 1} entries`);
