#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company + fuzzy role match, then gates collapse on
 * the report `**URL:**` header. A fuzzy match is only collapsed when both
 * rows' reports resolve to the same URL. When URLs differ, the rows are
 * kept apart even if the role text fuzzy-matches.
 *
 * Keeps entry with highest score. If a discarded entry had a more advanced
 * status, that status is promoted onto the keeper. Notes are not merged.
 *
 * Run: node career-ops/dedup-tracker.mjs [--dry-run]
 *
 * URL-aware tightening (js-a8r): the older fuzzy-only heuristic produced
 * false positives whenever a company had multiple adjacent-but-distinct
 * reqs. Examples we caught in the wild:
 *
 *   - "Partner Solutions Architect" vs "Solutions Architect" (Glean)
 *     → different reqs (enterprise/partner vs post-sale)
 *   - "Data Scientist, Core Data - PhD (2026)" vs "Data Scientist" (Figma)
 *     → PhD cohort vs general DS
 *   - "Forward Deployed Banker" vs "Forward Deployed Investor" (Hebbia)
 *     → different roles despite fuzzy-matching on "forward deployed"
 *   - "Applied AI Engineer (Digital Natives Business)" vs
 *     "Forward Deployed Engineer, Applied AI (Digital Natives)" (Anthropic)
 *     → two different Anthropic reqs with different job IDs
 *
 * Each pair has distinct URLs in their report headers, so the URL gate now
 * keeps them apart. Fallback: when either row's report can't be read or
 * has no `**URL:**` line, we fall back to the legacy fuzzy-only heuristic
 * so legacy rows without reports still get deduped.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

function normalizeCompany(name) {
  return name.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

function roleMatch(a, b) {
  const filterStopwords = (words) =>
    words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));

  const wordsA = filterStopwords(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filterStopwords(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap.length / smaller;

  return overlap.length >= 2 && ratio >= 0.6;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Pull the path out of an applications.md report cell like
// "[051](reports/051-anthropic-...md)". Returns null if the cell has no
// markdown link (legacy rows pre-dating the report column).
function extractReportPath(reportCell) {
  if (!reportCell) return null;
  const m = reportCell.match(/\(([^)]+\.md)\)/);
  return m ? m[1] : null;
}

// Read a report's `**URL:**` header value. Returns null when the file is
// missing, unreadable, or has no URL line. Same head-window + regex shape
// as app/server/src/index/parsers/reportMd.ts so behavior matches the
// canonical parser.
function extractReportUrl(reportPath) {
  if (!reportPath) return null;
  const abs = join(CAREER_OPS, reportPath);
  if (!existsSync(abs)) return null;
  let head;
  try {
    head = readFileSync(abs, 'utf-8').split(/\r?\n/).slice(0, 25).join('\n');
  } catch {
    return null;
  }
  const m = head.match(/\*\*URL:\*\*\s*([^\n]*?)(?=\s*·\s*\*\*|$)/m);
  if (!m) return null;
  const v = (m[1] || '').trim();
  return v.length === 0 ? null : v;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
    raw: line,
  };
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Parse all entries
const entries = [];
const entryLineMap = new Map(); // num → line index

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    entries.push(app);
    entryLineMap.set(app.num, i);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Group by company+role
const groups = new Map();
for (const entry of entries) {
  const key = normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Find duplicates
let removed = 0;
let urlGateBlocked = 0;
const linesToRemove = new Set();
// Cache extracted URLs per entry.num so we read each report at most once.
const urlByNum = new Map();
function urlFor(entry) {
  if (urlByNum.has(entry.num)) return urlByNum.get(entry.num);
  const url = extractReportUrl(extractReportPath(entry.report));
  urlByNum.set(entry.num, url);
  return url;
}

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;

  // Within same company, find role matches
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);
    const seedUrl = urlFor(companyEntries[i]);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (!roleMatch(companyEntries[i].role, companyEntries[j].role)) continue;
      // URL gate: when both reports resolve to a URL, the candidate must
      // share it with the seed. If either side is missing a URL we fall
      // back to fuzzy-only (legacy behavior) so old rows still dedup.
      const candUrl = urlFor(companyEntries[j]);
      if (seedUrl && candUrl && seedUrl !== candUrl) {
        urlGateBlocked++;
        console.log(
          `🔒 Keep #${companyEntries[i].num} and #${companyEntries[j].num} apart — fuzzy match but URLs differ (${seedUrl} vs ${candUrl})`,
        );
        continue;
      }
      cluster.push(companyEntries[j]);
      processed.add(j);
    }

    if (cluster.length < 2) continue;

    // Keep the one with highest score
    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    // Check if any removed entry has more advanced status
    let bestStatusRank = STATUS_RANK[keeper.status.toLowerCase()] || 0;
    let bestStatus = keeper.status;
    for (let k = 1; k < cluster.length; k++) {
      const rank = STATUS_RANK[cluster[k].status.toLowerCase()] || 0;
      if (rank > bestStatusRank) {
        bestStatusRank = rank;
        bestStatus = cluster[k].status;
      }
    }

    // Update keeper's status if a removed entry had a more advanced one
    if (bestStatus !== keeper.status) {
      const lineIdx = entryLineMap.get(keeper.num);
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        parts[6] = bestStatus;
        lines[lineIdx] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
        console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
      }
    }

    // Remove duplicates
    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      const lineIdx = entryLineMap.get(dup.num);
      if (lineIdx !== undefined) {
        linesToRemove.add(lineIdx);
        removed++;
        console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
      }
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);
if (urlGateBlocked > 0) {
  console.log(`🔒 ${urlGateBlocked} fuzzy match(es) kept apart by URL gate`);
}

if (!DRY_RUN && removed > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
