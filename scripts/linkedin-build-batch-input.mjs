#!/usr/bin/env node
// Build batch/batch-input.tsv from data/pipeline.md unchecked rows,
// renumbering surviving rows starting at id 1 so the batch-runner state file
// is fresh. Already-evaluated URLs are filtered later by Stage 5
// (scripts/filter-batch-input.mjs) against reports/*.md headers.

import { readFileSync, writeFileSync } from 'node:fs';

const PIPELINE = 'data/pipeline.md';
const OUT = 'batch/batch-input.tsv';

// Encode spaces in URL path segments (Ashby slugs with spaces).
function fixUrl(url) {
  // Only target the path, preserve scheme://host and query as-is.
  const m = url.match(/^(https?:\/\/[^/]+)(\/[^?#]*)(.*)$/);
  if (!m) return url;
  const [, origin, path, rest] = m;
  // Replace literal spaces in path segments with %20.
  const fixedPath = path.split('/').map(seg => seg.replace(/ /g, '%20')).join('/');
  return origin + fixedPath + rest;
}

const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
const rows = ['id\turl\tsource\tnotes'];

let id = 1;
for (const raw of lines) {
  // URL may contain literal spaces (Ashby slugs like "Wisdom AI"), so match
  // everything up to " | " instead of relying on \S+.
  const m = raw.match(/^- \[ \] (https?:\/\/.+?)\s+\|\s*([^|]+)\|\s*(.+)$/);
  if (!m) continue;
  const url = m[1];
  const company = m[2].trim();
  const restRaw = m[3].trim();
  // role | location  OR just role (no pipe)
  const pipeIdx = restRaw.indexOf('|');
  const role = pipeIdx >= 0 ? restRaw.slice(0, pipeIdx).trim() : restRaw;
  const loc = pipeIdx >= 0 ? restRaw.slice(pipeIdx + 1).trim() : '';
  let source = 'LinkedIn';
  if (url.includes('greenhouse.io') || url.includes('grnh.se')) source = 'Greenhouse';
  else if (url.includes('ashbyhq.com')) source = 'Ashby';
  else if (url.includes('lever.co')) source = 'Lever';
  const fixedUrl = fixUrl(url);
  const notes = `${company} | ${role}${loc ? ' | ' + loc : ''}`;
  rows.push(`${id}\t${fixedUrl}\t${source}\t${notes}`);
  id++;
}

writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`Wrote ${rows.length - 1} entries to ${OUT}`);
