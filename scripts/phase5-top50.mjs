#!/usr/bin/env node
// Phase 5 top-50 selector. Reads pipeline.md (already option-3 filtered) and
// portals.yml, picks 50 highest-priority roles by:
//   1. Lane priority: frontier_ai_nyc > ai_scaleup_nyc > ai_infra_startup
//      > ai_devtools_startup > sports_tech_startup
//   2. Within lane: archetype priority match on title (Applied AI > Applied
//      ML/DS > FDE > MLE > Solutions Architect > everything else)
//
// Writes:
//   - data/pipeline-top50.md   → top 50 in priority order, checkbox format
//   - data/pipeline-deferred.md → remaining 65 deferred to next pass

import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const TOP_N = 50;

const LANE_RANK = {
  frontier_ai_nyc: 1,
  ai_scaleup_nyc: 2,
  ai_infra_startup: 3,
  ai_devtools_startup: 4,
  sports_tech_startup: 5,
};

// Archetype priority — lower = higher priority. Based on Ben's CLAUDE.md.
const ARCHETYPE_PATTERNS = [
  { rank: 1, re: /\bapplied ai\b|\bapplied ml\b|\bllm engineer\b/i,  name: 'Applied AI/LLM' },
  { rank: 2, re: /\bproduct data scientist\b|\bdata scientist,? product\b/i, name: 'Applied ML / Product DS' },
  { rank: 3, re: /\bforward deployed\b|\bfde\b|\bdeployed engineer\b/i, name: 'FDE' },
  { rank: 4, re: /\bmachine learning engineer\b|\bml engineer\b|\bai\/ml engineer\b|\bai engineer\b/i, name: 'ML Engineer' },
  { rank: 5, re: /\bsolutions architect\b|\bsolutions engineer\b|\bai solutions\b|\bcustomer engineer\b/i, name: 'Solutions Architect' },
  { rank: 6, re: /\bmember of technical staff\b/i, name: 'MTS (generic)' },
  { rank: 7, re: /\bresearch engineer\b/i, name: 'Research Engineer' },
  { rank: 8, re: /\bdata scientist\b/i, name: 'Data Scientist' },
  { rank: 9, re: /\bsoftware engineer\b|\bfull.?stack\b|\bbackend\b/i, name: 'SWE (general)' },
];

function archetypeRank(title) {
  for (const p of ARCHETYPE_PATTERNS) if (p.re.test(title)) return { rank: p.rank, name: p.name };
  return { rank: 99, name: 'Other' };
}

function main() {
  const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const companyLane = new Map();
  for (const c of portals.tracked_companies || []) {
    companyLane.set(c.name.toLowerCase(), c.lane || 'unknown');
  }

  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+) \| ([^|]+) \| ([^|]+)(.*)$/);
    if (!m) continue;
    const url = m[1];
    const company = m[2].trim();
    const role = m[3].trim();
    const locPart = m[4] || '';
    const lane = companyLane.get(company.toLowerCase()) || 'unknown';
    const laneScore = LANE_RANK[lane] ?? 99;
    const { rank: archetypeScore, name: archetype } = archetypeRank(role);
    entries.push({ url, company, role, lane, laneScore, archetypeScore, archetype, rawLocSuffix: locPart });
  }

  entries.sort((a, b) => {
    if (a.laneScore !== b.laneScore) return a.laneScore - b.laneScore;
    if (a.archetypeScore !== b.archetypeScore) return a.archetypeScore - b.archetypeScore;
    return a.company.localeCompare(b.company);
  });

  const top = entries.slice(0, TOP_N);
  const deferred = entries.slice(TOP_N);

  // Write top-50 pipeline
  const header = `# Pipeline (Top ${TOP_N} — Phase 5 batch 1)\n\n## Pendientes\n\n`;
  const topLines = top.map(e => `- [ ] ${e.url} | ${e.company} | ${e.role}${e.rawLocSuffix}`).join('\n');
  writeFileSync('data/pipeline-top50.md', header + topLines + '\n');

  // Write deferred
  const defHeader = `# Pipeline (Deferred — Phase 5 batch 2)\n\n## Pendientes\n\n`;
  const defLines = deferred.map(e => `- [ ] ${e.url} | ${e.company} | ${e.role}${e.rawLocSuffix}`).join('\n');
  writeFileSync('data/pipeline-deferred.md', defHeader + defLines + '\n');

  console.log(`Wrote data/pipeline-top50.md (${top.length} entries)`);
  console.log(`Wrote data/pipeline-deferred.md (${deferred.length} entries)`);
  console.log(`\nTop-50 lane breakdown:`);
  const laneCounts = {};
  for (const e of top) laneCounts[e.lane] = (laneCounts[e.lane] || 0) + 1;
  for (const [l, n] of Object.entries(laneCounts).sort((a,b) => (LANE_RANK[a[0]]||99) - (LANE_RANK[b[0]]||99))) {
    console.log(`  ${l.padEnd(22)} ${n}`);
  }
  console.log(`\nTop-50 archetype breakdown:`);
  const archCounts = {};
  for (const e of top) archCounts[e.archetype] = (archCounts[e.archetype] || 0) + 1;
  for (const [a, n] of Object.entries(archCounts).sort((x,y) => y[1]-x[1])) {
    console.log(`  ${a.padEnd(28)} ${n}`);
  }
  console.log(`\nTop-50 company breakdown:`);
  const compCounts = {};
  for (const e of top) compCounts[e.company] = (compCounts[e.company] || 0) + 1;
  for (const [c, n] of Object.entries(compCounts).sort((x,y) => y[1]-x[1])) {
    console.log(`  ${c.padEnd(28)} ${n}`);
  }
}

main();
