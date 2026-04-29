#!/usr/bin/env node
// Build batch/batch-input.tsv from data/pipeline.md lines after the
// pre-existing first 4 entries (Anthropic FDE, Cresta SFS, Figma DS PhD,
// Decagon SR SE — already evaluated as reports 051-054).
//
// Renumbers the 42 LinkedIn-sourced entries starting from id 1 so the
// batch-runner state file is fresh.

import { readFileSync, writeFileSync } from 'node:fs';

const PIPELINE = 'data/pipeline.md';
const OUT = 'batch/batch-input.tsv';
const SKIP_FIRST = 4;

// Pre-existing URLs already evaluated (matched by exact URL substring).
const ALREADY_EVALUATED = new Set([
  'https://job-boards.greenhouse.io/anthropic/jobs/4985877008',
  'https://job-boards.greenhouse.io/cresta/jobs/5026013008',
  'https://boards.greenhouse.io/figma/jobs/5976930004?gh_jid=5976930004',
  'https://jobs.ashbyhq.com/decagon/73ef8e9d-a6b3-4817-ab02-893c4ac72bad',
]);

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
  if (ALREADY_EVALUATED.has(url)) continue;
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
