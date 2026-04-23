#!/usr/bin/env node
// Phase 5 pre-filter: drop non-US locations, title excludes, SA/SE-in-sales-org,
// sub-$125K base comp, and JD-body signals (seniority ≥5yr, product-SWE-no-AI,
// finance domain-expert, low-level infra, ASR/speech).
// Re-fetches ATS APIs (zero LLM cost) to build url→info map, then rewrites
// pipeline.md with only postings that clear every filter.
//
// CLI flags:
//   --max-age-days=N  Drop postings with updated_at / publishedAt older than
//                     N days. Default: no age cutoff (all ages pass).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const FETCH_TIMEOUT_MS = 30000;
const CONCURRENCY = 8;
const COMP_FLOOR = 125000;

// ── CLI flags ─────────────────────────────────────────────────────────
let maxAgeDays = null;
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--max-age-days=(\d+)$/);
  if (m) maxAgeDays = parseInt(m[1], 10);
}

// ── HTML strip utility (for Greenhouse content field) ────────────────
// Greenhouse returns content as HTML-entity-encoded HTML (e.g. `&lt;p&gt;`),
// so we iterate the entity decode before stripping tags.
function decodeEntitiesOnce(s) {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&rsquo;|&lsquo;|&apos;|&#39;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/gi, '&');
}
function stripHtml(s) {
  if (!s) return '';
  let t = s;
  for (let i = 0; i < 2; i++) t = decodeEntitiesOnce(t);
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ashby compensation parser — schema varies; try known structures.
function extractAshbyMinBase(comp) {
  if (!comp) return null;
  const sc = comp.summaryComponents;
  if (Array.isArray(sc)) {
    for (const c of sc) {
      const label = (c.label || '').toLowerCase();
      const type = (c.compensationType || '').toLowerCase();
      const isBase = type === 'salary' || /base|salary/.test(label);
      const min = typeof c.minValue === 'number' ? c.minValue : (typeof c.min === 'number' ? c.min : null);
      if (isBase && typeof min === 'number' && min >= 1000 && min < 1e7) return min;
    }
  }
  if (typeof comp.minBaseSalary === 'number') return comp.minBaseSalary;
  return null;
}

// ── ATS parsers (extended from scan.mjs baseline) ────────────────────
function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: j.updated_at || null,
    department: (j.departments || []).map(d => d.name).filter(Boolean).join('; '),
    body: stripHtml(j.content || ''),
    minBaseSalary: null,
  }));
}
function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedAt: j.publishedAt || null,
    department: j.departmentName || '',
    body: j.descriptionPlain || '',
    minBaseSalary: extractAshbyMinBase(j.compensation),
  }));
}
function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    department: j.categories?.department || '',
    body: j.descriptionPlain || '',
    minBaseSalary: null,
  }));
}
const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

function detectApi(company) {
  // Append ?content=true for Greenhouse so the board response includes JD text
  // (saves an N-per-job second pass).
  const withGhContent = (url) => url.includes('content=true')
    ? url
    : url + (url.includes('?') ? '&' : '?') + 'content=true';
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: withGhContent(company.api) };
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
    return { type: 'greenhouse', url: withGhContent(`https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`) };
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

function isUsEligible(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();
  const hasNonUs = NON_US_PATTERNS.some(p => lower.includes(p));
  const nycTokens = ['new york','nyc','manhattan','brooklyn',' ny,',' ny;',' ny ',' ny)','ny,','ny;'];
  const hasNyc = nycTokens.some(t => lower.includes(t));
  if (hasNyc) return true;
  if (hasNonUs) return false;
  const remoteSubstrings = [
    'us-remote','us remote','remote - us','remote, us','remote us',
    'remote (us','remote (united','united states (remote',
    'anywhere in the us','anywhere in us',
    'north america','n. america','remote within the u',
  ];
  if (remoteSubstrings.some(t => lower.includes(t))) return true;
  if (/^(remote|anywhere|fully remote)\b/.test(lower.trim())) return true;
  return false;
}

// Title excludes per Ben's CLAUDE.md hard excludes + archetype priority.
const TITLE_EXCLUDES = [
  / director /i, / director,/i, /^director[, ]/i, /, director/i,
  /\bvp[, ]/i, /vice president/i, /\bsvp\b/i, /\bevp\b/i,
  /head of /i, /chief .* officer/i,
  /\bmanager\b/i,
  /\bstaff\+?\b(?! engineer)/i,
  /\bstaff\b/i,
  /\bsenior staff\b/i, /\bprincipal\b/i,
  /\bleader\b/i, /\blead,? /i, /^lead /i, / lead$/i, /, lead\b/i,
  /^research scientist\b/i, /, research scientist\b/i,
  /research engineer\s*\/\s*research scientist/i,
  /research scientist\s*\/\s*research engineer/i,
  /research engineer,? (pretraining|post-training|rl|reasoning|alignment|safety|privacy|retrieval|codex|frontier evals|science of scaling|production model|machine learning)/i,
  /clearance/i, /ts\/sci/i, /federal civilian/i, /public sector/i,
  /offensive security/i, /security research/i,
  /\bgov\b/i, /, gov/i, / - gov/i,
  /government technology/i, /state and local/i,
  /\bdefense\b/i,
  /, federal\b/i, / - federal\b/i, /\bfederal$/i,
  /\bsecurity architect\b/i, /\bsecurity engineer\b/i,
  /\bsafeguards\b/i, /\bsafeguards labs\b/i,
  /\bevangelist\b/i,
  /\bsupport operations\b/i,
  /data scientist,? (strategic finance|strategic intelligence|financial engineering|business|support|integrity|safety systems|unit economics|platform and b2b|codex)/i,
  /\bstrategic finance\b/i, /\bfinancial engineering\b/i, /\bunit economics\b/i,
  /\bstrategic intelligence\b/i, /\brisk\b.*data scientist/i,
  /\bgrowth engineer\b/i, /\bgrowth,? full[- ]?stack/i,
  /\brevenue platform\b/i, /\bgtm\b/i, /\bpeople innovation\b/i,
  /\bfleet scheduling\b/i, /\bdata acquisition\b/i,
  /\bsocial products\b/i, /\bchatgpt enterprise\b/i,
  /\bb2b applications\b/i,
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
  /\bit solutions engineer\b/i, /\bit support\b/i, /\bsystems administrator\b/i,
  /helpdesk/i, /desktop support/i,
  /hardware engineer/i, /mechanical engineer/i, /electrical engineer/i,
  /site reliability/i, /\bsre\b/i,
];
function titleAllowed(title) {
  if (/\bmember of technical staff\b/i.test(title)) return true;
  return !TITLE_EXCLUDES.some(re => re.test(title));
}

// ── New predicates ───────────────────────────────────────────────────
// Layer B: department filter. Only drop when the title looks SA/SE-adjacent
// AND the dept is in a sales/GTM/finance org. Protects Cresta-FDE-in-Delivery
// false-negatives where FDE titles sit in non-sales orgs.
const SA_SE_LIKE_TITLE = /solutions (architect|engineer|consultant)|partner solutions|field engineer|ai strategist/i;
// "AI Strategy" catches Hebbia's domain-expert FDE/Strategist roles;
// "Customer Outcomes" catches Glean's post-sales SA org. Both are only
// consulted when the title also looks SA/SE-like, so technical engineers
// who happen to sit in these orgs aren't dropped.
const SALES_ADJACENT_DEPT = /\b(sales|go[- ]?to[- ]?market|gtm|customer (success|outcomes|operations)|field engineering|partnerships?|revenue|business development|finance|banking|ai strategy|post[- ]sales)\b/i;

function departmentAllowed(title, dept) {
  if (!dept) return { ok: true };
  if (SA_SE_LIKE_TITLE.test(title) && SALES_ADJACENT_DEPT.test(dept)) {
    return { ok: false, signal: `dept=${dept}` };
  }
  return { ok: true };
}

// Layer D: comp floor. Only applies when we have a confirmed number.
function compAllowed(minBase) {
  if (typeof minBase !== 'number') return { ok: true };
  if (minBase < COMP_FLOOR) {
    return { ok: false, signal: `$${minBase.toLocaleString()}` };
  }
  return { ok: true };
}

// Layer C: JD body regex predicates.
function extractMinYears(body) {
  if (!body) return 0;
  let maxY = 0;
  const patA = /(\d+)\+?\s*years?\s+(?:of\s+)?(?:relevant\s+|prior\s+|professional\s+|industry\s+|work\s+|total\s+|hands[- ]?on\s+)?(?:experience|exp\b|working\s+in|in\s+[a-z])/gi;
  const patB = /(?:minimum|at\s+least|required:?|requires)\s+(?:of\s+)?(\d+)\+?\s*years?/gi;
  for (const pat of [patA, patB]) {
    for (const m of body.matchAll(pat)) {
      const n = parseInt(m[1], 10);
      if (n > maxY && n <= 15) maxY = n;
    }
  }
  return maxY;
}

const PRODUCT_SWE_TITLE = /^(senior\s+)?(software engineer|full[- ]?stack(\s+software)?\s+engineer)(\b|,|$)/i;
const AI_KEYWORDS = /\b(LLMs?|\bML\b|machine learning|model training|model inference|model serving|embeddings?|\bRAG\b|fine[- ]?tun(e|ing)|prompt engineering|transformer|neural net|\bAI\/ML\b|AI\s+(engineer|system)|generative ai|agents?|claude|gpt-?\d|openai|anthropic)\b/i;

const FINANCE_EXPERT = [
  /ex[- ]banker/i,
  /investment banking (background|experience|required)/i,
  /former (analyst|associate|vp|banker) at\b/i,
  /ex[- ]lawyer/i,
  /corporate law (required|background)/i,
  /\bm&a\b.*(advisory|experience|required)/i,
  /former (investor|investment)/i,
  /buy[- ]?side (experience|background|required)/i,
  /private equity (background|experience)/i,
  /hedge fund (background|experience)/i,
];
const INFRA_TERMS = [
  /\bCUDA\b/i, /\bvLLM\b/i, /\bTensorRT\b/i, /\bFlashAttention\b/i, /\btriton\b/i,
  /kernel (optimi|fusi)/i, /GPU memory/i, /\bquantization\b/i, /\btensor parallel/i,
  /speculative decoding/i,
];
const INFRA_TITLE = /(performance|systems|infrastructure|\bplatform\b)/i;
const ASR_PATTERN = /\b(ASR|automatic speech recognition|speech[- ]to[- ]text|speech recognition|speech models?)\b/i;

function jdBodyAllowed(title, body) {
  const yrs = extractMinYears(body);
  if (yrs >= 5) return { ok: false, signal: `min ${yrs}yr` };

  if (PRODUCT_SWE_TITLE.test(title) && body && !AI_KEYWORDS.test(body)) {
    return { ok: false, signal: 'product-SWE-no-AI' };
  }

  const financeHits = FINANCE_EXPERT.filter(r => r.test(body)).length;
  if (financeHits >= 2) return { ok: false, signal: `finance-expert(${financeHits})` };

  const infraHits = INFRA_TERMS.filter(r => r.test(body)).length;
  if (infraHits >= 3 && INFRA_TITLE.test(title)) {
    return { ok: false, signal: `low-level-infra(${infraHits})` };
  }

  if (ASR_PATTERN.test(title) || (body && ASR_PATTERN.test(body.slice(0, 500)))) {
    return { ok: false, signal: 'asr/speech' };
  }

  return { ok: true };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = (config.tracked_companies || [])
    .filter(c => c.enabled !== false)
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  console.log(`Fetching ${companies.length} company APIs…`);
  if (maxAgeDays !== null) {
    console.log(`  --max-age-days=${maxAgeDays} (will drop postings older than that)`);
  }
  const locMap = new Map();
  let fetchOk = 0, fetchFail = 0;

  let idx = 0;
  async function worker() {
    while (idx < companies.length) {
      const c = companies[idx++];
      try {
        const json = await fetchJson(c._api.url);
        const offers = PARSERS[c._api.type](json, c.name);
        for (const o of offers) {
          locMap.set(o.url, {
            location: o.location,
            title: o.title,
            company: o.company,
            postedAt: o.postedAt || null,
            department: o.department || '',
            body: o.body || '',
            minBaseSalary: o.minBaseSalary,
          });
        }
        fetchOk++;
      } catch (e) {
        fetchFail++;
        console.error(`  ! ${c.name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log(`  ${fetchOk} ok, ${fetchFail} failed. ${locMap.size} URL→info entries.`);

  const cutoff = maxAgeDays !== null
    ? new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
    : null;

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
    const dept = info?.department || '';
    const body = info?.body || '';
    const postedAt = info?.postedAt || null;
    const minBase = info?.minBaseSalary;

    const pushDrop = (reason, signal) => dropped.push({ url, company, role, location: loc, reason, signal: signal || '' });

    if (!isUsEligible(loc)) { pushDrop('loc', loc); continue; }
    if (!titleAllowed(title)) { pushDrop('title', title); continue; }

    if (cutoff && postedAt && new Date(postedAt) < cutoff) {
      pushDrop('stale', postedAt.slice(0, 10));
      continue;
    }

    const deptCheck = departmentAllowed(title, dept);
    if (!deptCheck.ok) { pushDrop('dept', deptCheck.signal); continue; }

    const compCheck = compAllowed(minBase);
    if (!compCheck.ok) { pushDrop('comp', compCheck.signal); continue; }

    const bodyCheck = jdBodyAllowed(title, body);
    if (!bodyCheck.ok) { pushDrop('body', bodyCheck.signal); continue; }

    kept.push({ url, company, role, location: loc });
  }

  console.log(`\nKept: ${kept.length}   Dropped: ${dropped.length}`);
  for (const reason of ['loc', 'title', 'stale', 'dept', 'comp', 'body']) {
    const n = dropped.filter(d => d.reason === reason).length;
    if (n > 0) console.log(`  by ${reason.padEnd(6)}: ${n}`);
  }

  const header = `# Pipeline\n\n## Pendientes\n\n`;
  const keptLines = kept.map(k => `- [ ] ${k.url} | ${k.company} | ${k.role}${k.location ? ' | ' + k.location : ''}`).join('\n');
  writeFileSync(PIPELINE_PATH, header + keptLines + '\n');
  console.log(`\nRewrote ${PIPELINE_PATH} with ${kept.length} entries.`);

  const dropHeader = `reason\tsignal\tcompany\trole\tlocation\turl\n`;
  const dropLog = dropped.map(d =>
    `${d.reason}\t${d.signal}\t${d.company}\t${d.role}\t${d.location}\t${d.url}`
  ).join('\n');
  writeFileSync('data/phase5-dropped.tsv', dropHeader + dropLog + '\n');
  console.log(`Wrote audit trail to data/phase5-dropped.tsv`);
}

main().catch(e => { console.error(e); process.exit(1); });
