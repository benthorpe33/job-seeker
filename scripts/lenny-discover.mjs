#!/usr/bin/env node
/**
 * lenny-discover.mjs — find open roles at the companies on Lenny's lists
 * (lennysjobs.com/next50 + /lenny100) that the portal scanner does not cover.
 *
 * Input:  data/lenny/companies.tsv   (list \t name \t domain)
 * Output: data/lenny/discovery.json  (boards found + matching roles)
 *
 * For each company it guesses ATS slugs and probes the public Greenhouse,
 * Ashby and Lever JSON boards, applies the portals.yml title + location
 * filters (plus a few deployment/DS terms), and flags what is already in
 * the tracker, pipeline or scan history. It never writes pipeline.md.
 *
 * Usage: node scripts/lenny-discover.mjs [--only "Name"]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('portals.yml', 'utf-8'));
const EXTRA_POSITIVE = ['deployment', 'deployed', 'strategist', 'data science', 'applied research', 'decision science'];
const positive = [...(cfg.title_filter?.positive || []), ...EXTRA_POSITIVE].map(s => s.toLowerCase());
const negative = (cfg.title_filter?.negative || []).map(s => s.toLowerCase());
const titleOk = t => { const l = t.toLowerCase(); return positive.some(k => l.includes(k)) && !negative.some(k => l.includes(k)); };

const allow = (cfg.location_filter?.allow || []).map(s => s.toLowerCase());
const deny = (cfg.location_filter?.deny || []).map(s => s.toLowerCase());
const locOk = loc => {
  if (!loc) return true;
  const tokens = loc.toLowerCase().split(/[|;/]| and | or /).map(t => t.trim()).filter(Boolean);
  return tokens.length === 0 || tokens.some(t => allow.some(k => t.includes(k)) && !deny.some(k => t.includes(k)));
};

const tracked = new Set((cfg.tracked_companies || []).map(c => c.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
const apps = existsSync('data/applications.md') ? readFileSync('data/applications.md', 'utf-8') : '';
const pipe = existsSync('data/pipeline.md') ? readFileSync('data/pipeline.md', 'utf-8') : '';
const hist = existsSync('data/scan-history.tsv') ? readFileSync('data/scan-history.tsv', 'utf-8') : '';
const seenText = apps + '\n' + pipe + '\n' + hist;
const appCompanies = new Set();
for (const line of apps.split('\n')) {
  const c = line.split('|').map(s => s.trim());
  if (c.length > 5 && /^\d+$/.test(c[1])) appCompanies.add(c[3].toLowerCase().replace(/[^a-z0-9]/g, ''));
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally { clearTimeout(t); }
}
async function retry(fn, n = 2) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n) return undefined; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
}

function slugs(name, domain) {
  const base = name.replace(/\(.*?\)/g, '').trim();
  const lower = base.toLowerCase();
  const nospace = lower.replace(/[^a-z0-9]/g, '');
  const hyph = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const label = domain.split('.')[0].replace(/[^a-z0-9-]/g, '');
  const core = lower.replace(/\b(ai|labs?|inc|technologies|security|health|industries|robotics)\b/g, '').replace(/[^a-z0-9]/g, '');
  const set = new Set([nospace, hyph, label, label.replace(/-/g, ''), core, nospace + 'ai', nospace + 'hq', nospace + 'labs', 'use' + nospace, 'get' + nospace, 'try' + nospace].filter(s => s && s.length > 1));
  return [...set];
}

const probes = {
  greenhouse: async s => {
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${s}`);
    if (!meta) return null;
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=false`);
    if (!j) return null;
    return {
      boardName: meta.name,
      jobs: (j.jobs || []).map(x => ({ title: x.title, url: x.absolute_url, location: x.location?.name || '', posted: x.first_published || x.updated_at || '' })),
    };
  },
  ashby: async s => {
    const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`);
    if (!j || !Array.isArray(j.jobs)) return null;
    return {
      jobs: j.jobs.map(x => ({
        title: x.title, url: x.jobUrl,
        location: [x.location, ...(x.secondaryLocations || []).map(l => l?.location)].filter(Boolean).join(' | '),
        posted: x.publishedAt || '', remote: x.isRemote ? 'remote' : (x.workplaceType || ''),
        comp: x.compensation?.compensationTierSummary || x.compensation?.scrapeableCompensationSalarySummary || '',
      })),
    };
  },
  lever: async s => {
    const j = await getJson(`https://api.lever.co/v0/postings/${s}?mode=json`);
    if (!Array.isArray(j) || j.length === 0) return null;
    return {
      jobs: j.map(x => ({
        title: x.text, url: x.hostedUrl, location: x.categories?.location || '',
        posted: x.createdAt ? new Date(x.createdAt).toISOString() : '', remote: x.workplaceType || '',
      })),
    };
  },
};

const rows = readFileSync('data/lenny/companies.tsv', 'utf-8').split('\n').slice(1).filter(Boolean).map(l => {
  const [list, name, domain] = l.split('\t'); return { list, name, domain };
});
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].toLowerCase() : null;
const todo = rows.filter(r => !only || r.name.toLowerCase().includes(only));

const out = [];
let idx = 0;
async function worker() {
  while (idx < todo.length) {
    const r = todo[idx++];
    const res = { ...r, boards: [], errors: [] };
    for (const slug of slugs(r.name, r.domain)) {
      for (const [ats, fn] of Object.entries(probes)) {
        const hit = await retry(() => fn(slug));
        if (hit) res.boards.push({ ats, slug, boardName: hit.boardName, total: hit.jobs.length, jobs: hit.jobs });
      }
    }
    res.alreadyScanned = tracked.has(r.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    res.inTracker = appCompanies.has(r.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    out.push(res);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

// Summarize
out.sort((a, b) => todo.findIndex(x => x.name === a.name) - todo.findIndex(x => x.name === b.name));
for (const r of out) {
  for (const b of r.boards) {
    b.matches = b.jobs.filter(j => titleOk(j.title) && locOk(j.location)).map(j => ({ ...j, seen: seenText.includes(j.url) }));
    b.titleMatches = b.jobs.filter(j => titleOk(j.title)).length;
  }
}
writeFileSync('data/lenny/discovery.json', JSON.stringify(out, null, 1));

let nBoards = 0, nNone = 0;
for (const r of out) {
  if (r.boards.length) nBoards++; else nNone++;
  const tag = r.alreadyScanned ? ' [already in portals.yml]' : r.inTracker ? ' [in tracker]' : '';
  if (!r.boards.length) { console.log(`✗ ${r.name} (${r.list}) — no public GH/Ashby/Lever board found${tag}`); continue; }
  for (const b of r.boards) {
    console.log(`✓ ${r.name} (${r.list}) ${b.ats}/${b.slug}${b.boardName ? ' "' + b.boardName + '"' : ''} — ${b.total} jobs, ${b.matches.length} match${tag}`);
  }
}
console.log(`\n${nBoards} companies with a board, ${nNone} without. Detail: data/lenny/discovery.json`);
