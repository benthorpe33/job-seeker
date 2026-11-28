#!/usr/bin/env node
// One-off: bucket reports by archetype, tally keywords + gaps in the AI-eng family
// vs everything else, to surface what an AI-engineering-tailored CV should emphasize.

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(ROOT, 'reports');

// Archetype buckets — names taken from modes/_profile.md
const AI_ENG_ARCHETYPES = [
  /applied ai/i,
  /llm engineer/i,
  /forward[- ]deployed/i,
  /\bfde\b/i,
  /agentic/i,
  /automation engineer/i,
  /ml engineer.*(train|serv|infer)/i,
  /\bmlops?\b/i,
  /ai solutions? (architect|engineer)/i,
  /solutions? architect/i,
  /ai engineer/i,
];

const NON_AI_ENG_ARCHETYPES = [
  /product data scientist/i,
  /\bdata scientist\b/i,
  /research engineer/i,
  /\bswe\b/i,
  /software engineer/i,
  /full[- ]?stack/i,
  /frontend/i,
  /backend/i,
];

function classifyArchetype(arch) {
  if (!arch) return 'unknown';
  for (const re of AI_ENG_ARCHETYPES) if (re.test(arch)) return 'ai-eng';
  for (const re of NON_AI_ENG_ARCHETYPES) if (re.test(arch)) return 'other';
  return 'other';
}

function parseReport(path) {
  const content = readFileSync(path, 'utf-8');
  const plain = content.replace(/\*\*/g, '');

  // Header may be either "Archetype:" on its own line OR a table cell "| Archetype | ..."
  let archetype = null;
  const headerArch = plain.match(/Archetype:\s*([^\n·|]+)/i);
  if (headerArch) archetype = headerArch[1].trim();
  if (!archetype) {
    const tableArch = plain.match(/\|\s*Archetype\s*\|\s*([^\n|]+)\s*\|/i);
    if (tableArch) archetype = tableArch[1].trim();
  }

  // Score: SKIP or X.X/5
  let score = null;
  const skipMatch = plain.match(/Score:\s*SKIP/i);
  const numMatch = plain.match(/Score:\s*([\d.]+)\s*\/\s*5/i);
  if (skipMatch) score = 'SKIP';
  else if (numMatch) score = parseFloat(numMatch[1]);

  // Keywords section
  let keywords = [];
  const kwMatch = content.match(/##\s*Keywords[^\n]*\n+([\s\S]*?)(?=\n##|\n#|$)/i);
  if (kwMatch) {
    keywords = kwMatch[1]
      .split(/[,\n]/)
      .map(s => s.replace(/^[-*\s]+/, '').trim())
      .filter(s => s && s.length > 1 && s.length < 80 && !/^[#*]/.test(s));
  }

  // Gaps section (recurring phrases the agent flagged about Ben's CV)
  const gaps = [];
  const gapBlock = content.match(/###?\s*Gaps?\s*\n+([\s\S]*?)(?=\n###|\n##|$)/i);
  if (gapBlock) {
    const lines = gapBlock[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d+\.|[-*])\s+\*?\*?(.+?)\*?\*?(?::|\.|$)/);
      if (m) {
        const desc = m[1].replace(/\(.+?\)/g, '').trim();
        if (desc.length > 5 && desc.length < 200) gaps.push(desc);
      }
    }
  }

  return { path, archetype, score, keywords, gaps };
}

function normalizeKw(kw) {
  return kw.toLowerCase()
    .replace(/[.,;:()"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the |^a |^an /, '')
    .trim();
}

// Group near-duplicates under canonical forms
const CANONICAL = [
  [/^(llms?|large language models?)$/, 'LLM'],
  [/^(claude|gpt|anthropic api|openai api)$/, 'LLM API (Claude/GPT/Anthropic/OpenAI)'],
  [/^(agent frameworks?|agentic frameworks?|agent\/retrieval frameworks?)$/, 'agent frameworks'],
  [/^(agents?|ai agents?|agentic|agentic systems?|agentic workflows?)$/, 'agents/agentic'],
  [/^(rag|retrieval augmented generation|retrieval frameworks?|retrieval)$/, 'RAG/retrieval'],
  [/^(eval|evals|evaluation frameworks?|evaluation suites?|evaluations?)$/, 'evals/eval frameworks'],
  [/^(prompt engineering|prompting|prompt design)$/, 'prompt engineering'],
  [/^(fine[- ]?tuning|finetune)$/, 'fine-tuning'],
  [/^(tool[- ]?use|tool calling|function calling)$/, 'tool-use/function-calling'],
  [/^(mcp|model context protocol)$/, 'MCP'],
  [/^(production llm systems?|production ai|production ai systems?)$/, 'production AI/LLM systems'],
  [/^(forward[- ]?deployed engineer|fde)$/, 'FDE'],
  [/^(applied ai|applied ai engineer)$/, 'Applied AI'],
  [/^(customer[- ]?facing|customer engineer|customer success engineer)$/, 'customer-facing'],
  [/^(deployment at scale|deployment|deploy)$/, 'deployment'],
  [/^(observability|monitoring|tracing)$/, 'observability'],
  [/^(ci\/?cd|continuous integration)$/, 'CI/CD'],
  [/^(orchestration|llm orchestration|workflow orchestration)$/, 'orchestration'],
  [/^(python)$/, 'Python'],
  [/^(typescript|ts)$/, 'TypeScript'],
  [/^(javascript|js)$/, 'JavaScript'],
  [/^(aws|amazon web services)$/, 'AWS'],
  [/^(lambda|aws lambda)$/, 'AWS Lambda'],
  [/^(react|react\.js)$/, 'React'],
  [/^(postgres|postgresql)$/, 'Postgres'],
  [/^(knowledge graphs?|kg|neo4j)$/, 'knowledge graphs'],
  [/^(nlp|natural language processing)$/, 'NLP'],
  [/^(api|apis|rest api)$/, 'API/REST'],
  [/^(architecture design|architecture|system design)$/, 'architecture/system design'],
  [/^(safety|ai safety|steerability)$/, 'safety/steerability'],
  [/^(pilots?|prototypes?|pilot programs?)$/, 'pilots/prototypes'],
  [/^(reliability|pipeline reliability|production reliability)$/, 'reliability'],
  [/^(latency|low[- ]?latency)$/, 'latency'],
  [/^(cost reduction|cost optimization|token cost|inference cost)$/, 'cost optimization'],
  [/^(real[- ]?time|streaming|low latency real time)$/, 'real-time'],
  [/^(enterprise|enterprise customers?|enterprise saas)$/, 'enterprise'],
];

function canonicalize(kw) {
  const n = normalizeKw(kw);
  for (const [re, label] of CANONICAL) if (re.test(n)) return label;
  return n;
}

function main() {
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const parsed = files.map(f => parseReport(join(REPORTS_DIR, f)));

  // Bucket
  const buckets = { 'ai-eng': [], other: [], unknown: [] };
  for (const p of parsed) {
    const b = classifyArchetype(p.archetype);
    buckets[b].push(p);
  }

  console.log(`Total reports: ${parsed.length}`);
  console.log(`  ai-eng bucket: ${buckets['ai-eng'].length}`);
  console.log(`  other: ${buckets.other.length}`);
  console.log(`  unknown: ${buckets.unknown.length}`);

  // Score split inside ai-eng (skip vs scored)
  const aiSkip = buckets['ai-eng'].filter(p => p.score === 'SKIP').length;
  const aiHigh = buckets['ai-eng'].filter(p => typeof p.score === 'number' && p.score >= 4.0).length;
  const aiMid = buckets['ai-eng'].filter(p => typeof p.score === 'number' && p.score >= 3.0 && p.score < 4.0).length;
  console.log(`  ai-eng scored ≥4.0: ${aiHigh}  | 3.0–3.9: ${aiMid}  | SKIP: ${aiSkip}\n`);

  // Tally keywords by bucket (per-report set so dupes within a single report don't double-count)
  function tally(reports) {
    const counts = new Map();
    for (const r of reports) {
      const seen = new Set();
      for (const k of r.keywords) {
        const c = canonicalize(k);
        if (!c || c.length < 2) continue;
        if (seen.has(c)) continue;
        seen.add(c);
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  const aiKw = tally(buckets['ai-eng']);
  const otherKw = tally(buckets.other);
  const aiTotal = buckets['ai-eng'].length || 1;
  const otherTotal = buckets.other.length || 1;

  // AI-eng top by absolute frequency
  console.log('=== TOP 40 KEYWORDS IN AI-ENG REPORTS ===');
  console.log('rank  count  %ai    %other  lift   keyword');
  for (let i = 0; i < Math.min(40, aiKw.length); i++) {
    const [kw, c] = aiKw[i];
    const oc = otherKw.find(([k]) => k === kw)?.[1] || 0;
    const aiPct = (c / aiTotal) * 100;
    const otherPct = (oc / otherTotal) * 100;
    const lift = otherPct > 0 ? aiPct / otherPct : (aiPct > 0 ? 99 : 0);
    console.log(
      `${String(i + 1).padStart(3)}.  ${String(c).padStart(4)}  ${aiPct.toFixed(0).padStart(4)}%  ${otherPct.toFixed(0).padStart(5)}%  ${lift.toFixed(1).padStart(4)}x  ${kw}`
    );
  }

  // AI-eng specific (high lift)
  console.log('\n=== KEYWORDS MOST OVER-INDEXED ON AI-ENG (lift, min 5 occurrences) ===');
  const lifts = aiKw
    .filter(([, c]) => c >= 5)
    .map(([kw, c]) => {
      const oc = otherKw.find(([k]) => k === kw)?.[1] || 0;
      const aiPct = (c / aiTotal) * 100;
      const otherPct = (oc / otherTotal) * 100;
      const lift = otherPct > 0 ? aiPct / otherPct : 99;
      return { kw, c, oc, aiPct, otherPct, lift };
    })
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 25);
  for (const r of lifts) {
    console.log(
      `  ${r.lift.toFixed(1).padStart(5)}x  ${String(r.c).padStart(3)} ai-eng  ${String(r.oc).padStart(3)} other   ${r.kw}`
    );
  }

  // Recurring gaps in HIGH-SCORE AI-eng reports — what Ben under-signals on the strong-fit roles
  console.log('\n=== RECURRING GAPS IN AI-ENG REPORTS SCORED ≥4.0 (what Ben under-signals) ===');
  const highReports = buckets['ai-eng'].filter(p => typeof p.score === 'number' && p.score >= 4.0);
  const gapPhrases = new Map();
  const GAP_PATTERNS = [
    [/customer[- ]?facing|fde|forward[- ]?deployed|workshop|embed.*customer|client[- ]?facing/i, 'customer-facing / FDE track record'],
    [/agent.*production|agentic.*production|production.*agent|ship.*agent/i, 'shipping agents to production'],
    [/eval.*framework|evaluation.*suite|llm.*eval|eval.*production/i, 'LLM eval frameworks'],
    [/prompt engineer|prompt design|prompt opt/i, 'prompt engineering (explicit)'],
    [/llm.*ops|llmops|mlops|model serving|inference infra/i, 'LLMOps / inference infra'],
    [/scale|at scale|millions of|throughput|qps|tps/i, 'scale / high throughput'],
    [/years|yoe|year of experience|senior|staff/i, 'seniority / YOE gap'],
    [/fine[- ]?tun|train.*model|model training|rlhf/i, 'fine-tuning / training experience'],
    [/observab|tracing|monitor|telemet/i, 'LLM observability / tracing'],
    [/rag|retriev|vector|embedding|semantic search/i, 'RAG / retrieval systems'],
    [/typescript|node|frontend|react/i, 'TypeScript / frontend depth'],
    [/go|golang|rust/i, 'Go / Rust'],
    [/multi[- ]?agent|orchestrat|workflow/i, 'multi-agent / orchestration'],
    [/open[- ]?source|github|public.*demo|portfolio/i, 'public OSS / demos'],
    [/talk|conference|blog|publish|writ.*paper/i, 'public-facing presence (talks/blog)'],
    [/security|compliance|soc.?2|hipaa/i, 'security/compliance'],
    [/finance|fintech|trading|markets/i, 'finance/fintech domain'],
  ];
  for (const r of highReports) {
    const seen = new Set();
    for (const g of r.gaps) {
      for (const [re, label] of GAP_PATTERNS) {
        if (re.test(g) && !seen.has(label)) {
          seen.add(label);
          gapPhrases.set(label, (gapPhrases.get(label) || 0) + 1);
        }
      }
    }
  }
  const gapsRanked = [...gapPhrases.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, c] of gapsRanked) {
    const pct = highReports.length > 0 ? (c / highReports.length) * 100 : 0;
    console.log(`  ${String(c).padStart(3)} / ${highReports.length} (${pct.toFixed(0)}%)  ${label}`);
  }
}

main();
