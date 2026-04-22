#!/usr/bin/env node
// Phase 5 option-3 pre-filter: drop non-US locations + obvious title excludes.
// Re-fetches ATS APIs (no LLM cost) to build url->location map for every
// pending URL in data/pipeline.md, then rewrites pipeline.md with only
// US-eligible + target-title postings.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const FETCH_TIMEOUT_MS = 30000;
const CONCURRENCY = 8;

// ── Copy of scan.mjs parsers so we stay in sync behaviorally ──
function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: j.updated_at || null,
  }));
}
function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedAt: j.publishedAt || null,
  }));
}
function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}
const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

function detectApi(company) {
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }
  const url = company.careers_url || '';
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true` };
  }
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs` };
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Filters ──────────────────────────────────────────────────────────
// Non-US location patterns — if the posting says ONLY these, exclude.
// Postings with both NYC/US AND another city stay in (Anthropic does this often).
const NON_US_PATTERNS = [
  'tokyo','japan','paris','france','london','united kingdom',' uk','munich','germany',
  'dubai','uae','qatar','doha','india','bangalore','bengaluru','mumbai','hyderabad','delhi',
  'spain','madrid','barcelona','mexico','brazil','brasil','sao paulo','são paulo',
  'latam','oceania','australia','sydney','melbourne','poland','warsaw','krakow',
  'apac','emea','europe','canada','toronto','vancouver','montreal','dublin','ireland',
  'amsterdam','netherlands','berlin','zurich','switzerland','stockholm','sweden',
  'singapore','hong kong','seoul','korea','israel','tel aviv','lisbon','portugal',
  'italy','milan','rome','copenhagen','denmark','helsinki','finland','oslo','norway',
  'vienna','austria','prague','czech','bucharest','romania','athens','greece',
  'belgrade','serbia','bulgaria','sofia','ukraine','kyiv','kiev','budapest','hungary',
  'buenos aires','argentina','lima','peru','bogota','colombia','santiago','chile'
];

// Ben is Manhattan-based. Keep only:
//   1. postings that mention NYC / New York / Manhattan / Brooklyn, OR
//   2. US-remote postings (remote/anywhere paired with US signal), OR
//   3. blank location (let eval decide).
// Drop everything else — SF-only, Seattle-only, Austin-only, DC-only etc.
function isUsEligible(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();

  // Reject non-US first
  const hasNonUs = NON_US_PATTERNS.some(p => lower.includes(p));
  const nycTokens = ['new york','nyc','manhattan','brooklyn',' ny,',' ny;',' ny ',' ny)','ny,','ny;'];
  const hasNyc = nycTokens.some(t => lower.includes(t));

  // NYC overrides non-US flag (dual-location "London; NYC" keeps)
  if (hasNyc) return true;
  if (hasNonUs) return false;

  // US-remote variants — plain substring checks
  const remoteSubstrings = [
    'us-remote','us remote','remote - us','remote, us','remote us',
    'remote (us','remote (united','united states (remote',
    'anywhere in the us','anywhere in us',
    'north america','n. america','remote within the u',
  ];
  if (remoteSubstrings.some(t => lower.includes(t))) return true;

  // Pure "Remote" / "Anywhere" with no other qualifier → treat as US-remote
  if (/^(remote|anywhere|fully remote)\b/.test(lower.trim())) return true;

  // Everything else (SF-only, Seattle-only, etc.) → drop
  return false;
}

// Title excludes — Director/VP levels, PhD-mandatory research, pure robotics hardware,
// security-clearance-required public sector, sales/marketing/recruiter roles.
// Title excludes per Ben's CLAUDE.md hard excludes + archetype priority.
// Drops Director/VP, pure research (PhD-track), business/growth/revenue/finance DS,
// IT/support/security-ops, hardware, sales/marketing/recruiting.
const TITLE_EXCLUDES = [
  // Seniority excludes — IC-only, no leadership/management
  / director /i, / director,/i, /^director[, ]/i, /, director/i,
  /\bvp[, ]/i, /vice president/i, /\bsvp\b/i, /\bevp\b/i,
  /head of /i, /chief .* officer/i,
  // Manager: drop unless "Member of Technical Staff" (MTS is an IC title at labs)
  /\bmanager\b/i,
  // Staff / Staff+ / Senior Staff etc. — too senior for Ben
  /\bstaff\+?\b(?! engineer)/i,  // catches "Staff+", "Staff Research Engineer"
  /\bstaff\b/i,                   // broad — covers "Staff Software Engineer" etc.
  /\bsenior staff\b/i, /\bprincipal\b/i,
  // Leader / Lead (when it implies people management, not tech lead IC)
  /\bleader\b/i, /\blead,? /i, /^lead /i, / lead$/i, /, lead\b/i,
  // Exception carve-out: "Member of Technical Staff" is IC, keep it. Since
  // the /\bstaff\b/ rule above would drop it, reintroduce it in the allow-list
  // via a second pass (see titleAllowed below).

  // Research excludes (PhD-track, not product-leaning)
  /^research scientist\b/i, /, research scientist\b/i,
  /research engineer\s*\/\s*research scientist/i,
  /research scientist\s*\/\s*research engineer/i,
  // Pure research without "Applied" qualifier — drop pretraining/post-training/RL research IC roles
  /research engineer,? (pretraining|post-training|rl|reasoning|alignment|safety|privacy|retrieval|codex|frontier evals|science of scaling|production model|machine learning)/i,

  // Security / gov / clearance
  /clearance/i, /ts\/sci/i, /federal civilian/i, /public sector/i,
  /offensive security/i, /security research/i,
  /\bgov\b/i, /, gov/i, / - gov/i,
  /government technology/i, /state and local/i,
  /\bdefense\b/i,
  /, federal\b/i, / - federal\b/i, /\bfederal$/i,
  /\bsecurity architect\b/i, /\bsecurity engineer\b/i,
  /\bsafeguards\b/i, /\bsafeguards labs\b/i,

  // Not engineering / product DS
  /\bevangelist\b/i,
  /\bsupport operations\b/i,

  // Business / finance / growth / revenue / GTM / operations
  /data scientist,? (strategic finance|strategic intelligence|financial engineering|business|support|integrity|safety systems|unit economics|platform and b2b|codex)/i,
  /\bstrategic finance\b/i, /\bfinancial engineering\b/i, /\bunit economics\b/i,
  /\bstrategic intelligence\b/i, /\brisk\b.*data scientist/i,
  /\bgrowth engineer\b/i, /\bgrowth,? full[- ]?stack/i,
  /\brevenue platform\b/i, /\bgtm\b/i, /\bpeople innovation\b/i,
  /\bfleet scheduling\b/i, /\bdata acquisition\b/i,
  /\bsocial products\b/i, /\bchatgpt enterprise\b/i,
  /\bb2b applications\b/i,

  // Sales / marketing / HR / admin
  /recruiter/i, /talent acquisition/i,
  /account executive/i, /\bsales\b/i, /sales development/i,
  /\bsales engineer\b/i,
  /marketing manager/i, /content marketing/i, /product marketing/i,
  /executive assistant/i, /office manager/i,
  /chief of staff/i,
  /\bcustomer success\b/i,
  /\btechnical account manager\b/i,
  /\brevenue operations\b/i, /\brevops\b/i,
  /\bpartnerships?\b/i,

  // IT / support / corporate
  /\bit solutions engineer\b/i, /\bit support\b/i, /\bsystems administrator\b/i,
  /helpdesk/i, /desktop support/i,

  // Hardware / infra non-ML
  /hardware engineer/i, /mechanical engineer/i, /electrical engineer/i,
  /site reliability/i, /\bsre\b/i, // your archetype doesn't include SRE
];
function titleAllowed(title) {
  // Allow-list: "Member of Technical Staff" is the standard IC title at frontier
  // labs (Anthropic, Cohere, Perplexity, Fireworks, etc.) — keep even though
  // the word "Staff" would otherwise be excluded.
  if (/\bmember of technical staff\b/i.test(title)) return true;
  return !TITLE_EXCLUDES.some(re => re.test(title));
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = (config.tracked_companies || [])
    .filter(c => c.enabled !== false)
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  console.log(`Fetching ${companies.length} company APIs…`);
  const locMap = new Map(); // url -> {location, title, company}
  let fetchOk = 0, fetchFail = 0;

  // Concurrent fetch
  let idx = 0;
  async function worker() {
    while (idx < companies.length) {
      const c = companies[idx++];
      try {
        const json = await fetchJson(c._api.url);
        const offers = PARSERS[c._api.type](json, c.name);
        for (const o of offers) locMap.set(o.url, { location: o.location, title: o.title, company: o.company, postedAt: o.postedAt || null });
        fetchOk++;
      } catch (e) {
        fetchFail++;
        console.error(`  ! ${c.name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log(`  ${fetchOk} ok, ${fetchFail} failed. ${locMap.size} URL→location entries.`);

  const CUTOFF_DAYS = 14;
  const cutoff = new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000);

  // Parse pipeline.md
  const pipelineText = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = pipelineText.split('\n');
  const kept = [];
  const dropped = [];

  for (const line of lines) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+) \| ([^|]+) \| ([^|]+)(?:\s*\|.*)?$/);
    if (!m) continue;
    const url = m[1];
    const company = m[2].trim();
    const role = m[3].trim();
    const info = locMap.get(url);
    const loc = info?.location || '';
    const title = info?.title || role;
    const postedAt = info?.postedAt || null;

    const locOk = isUsEligible(loc);
    const titleOk = titleAllowed(title);
    const ageOk = !postedAt || new Date(postedAt) >= cutoff;

    if (locOk && titleOk && ageOk) {
      kept.push({ url: m[1], company, role, location: loc });
    } else {
      const reason = !locOk ? 'loc' : !titleOk ? 'title' : 'stale';
      dropped.push({ url: m[1], company, role, location: loc, reason });
    }
  }

  console.log(`\nKept: ${kept.length}   Dropped: ${dropped.length}`);
  console.log(`  by location: ${dropped.filter(d => d.reason === 'loc').length}`);
  console.log(`  by title:    ${dropped.filter(d => d.reason === 'title').length}`);
  console.log(`  by stale:    ${dropped.filter(d => d.reason === 'stale').length}`);

  // Rewrite pipeline.md
  const header = `# Pipeline\n\n## Pendientes\n\n`;
  const keptLines = kept.map(k => `- [ ] ${k.url} | ${k.company} | ${k.role}${k.location ? ' | ' + k.location : ''}`).join('\n');
  writeFileSync(PIPELINE_PATH, header + keptLines + '\n');
  console.log(`\nRewrote ${PIPELINE_PATH} with ${kept.length} entries.`);

  // Write dropped log for audit
  const dropLog = dropped.map(d => `${d.reason}\t${d.company}\t${d.role}\t${d.location}\t${d.url}`).join('\n');
  writeFileSync('data/phase5-dropped.tsv', `reason\tcompany\trole\tlocation\turl\n${dropLog}\n`);
  console.log(`Wrote audit trail to data/phase5-dropped.tsv`);
}

main().catch(e => { console.error(e); process.exit(1); });
