import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type {
  RejectionPatternCategory,
  RejectionPatternCompany,
  RejectionPatternKeyword,
  RejectionPatterns,
  RejectionReasonCategory,
  RejectionRecentReason,
  RejectionScoreBand,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";

const TSV_REL_PATH = "data/rejection-feedback.tsv";

const STOPWORDS = new Set<string>([
  "a", "the", "and", "or", "is", "are", "was", "were", "for", "below", "role",
  "not", "this", "that", "with", "without", "too", "no", "of", "to", "in",
  "on", "at", "by", "an", "be", "been", "has", "have", "had", "but", "as",
  "it", "its", "their", "our", "we", "you",
]);

const CATEGORY_KEYWORDS: { category: RejectionReasonCategory; tokens: string[] }[] = [
  { category: "seniority", tokens: ["junior", "senior", "level", "ic", "staff", "principal", "lead"] },
  { category: "comp", tokens: ["salary", "comp", "compensation", "pay", "budget", "range", "threshold", "floor"] },
  { category: "location", tokens: ["location", "remote", "onsite", "timezone", "relocate", "relocation"] },
  { category: "domain-fit", tokens: ["domain", "industry", "vertical", "fintech", "health", "healthcare", "gtm", "sales"] },
  { category: "skills", tokens: ["skill", "experience", "expertise", "stack", "language", "framework"] },
  { category: "culture", tokens: ["culture", "fit", "communication", "soft"] },
];

export type RejectionRow = {
  ts: string;
  applicationId: string;
  company: string;
  role: string;
  score: number | null;
  reason: string;
};

export function loadRejections(repoRoot: string = REPO_ROOT): RejectionRow[] {
  const path = join(repoRoot, TSV_REL_PATH);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const lines = text.split(/\r?\n/);
  const rows: RejectionRow[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    if (i === 0 && line.startsWith("ts\t")) continue; // header
    const cols = line.split("\t");
    if (cols.length < 6) continue;
    const [ts, applicationId, company, role, scoreRaw, ...rest] = cols;
    const reason = rest.join("\t");
    const scoreNum = scoreRaw ? Number.parseFloat(scoreRaw) : NaN;
    rows.push({
      ts: ts ?? "",
      applicationId: applicationId ?? "",
      company: (company ?? "").trim(),
      role: (role ?? "").trim(),
      score: Number.isFinite(scoreNum) ? scoreNum : null,
      reason: (reason ?? "").trim(),
    });
  }
  return rows;
}

export function extractKeywords(reason: string): string[] {
  const cleaned = reason.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 3);
  const out = new Set<string>();
  for (const raw of tokens) {
    if (STOPWORDS.has(raw)) continue;
    let stem = raw;
    if (stem.length > 3) {
      if (stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
      else if (stem.endsWith("es")) stem = stem.slice(0, -2);
      else if (stem.endsWith("s")) stem = stem.slice(0, -1);
    }
    if (STOPWORDS.has(stem)) continue;
    if (stem.length < 3) continue;
    out.add(stem);
  }
  return [...out];
}

export function bucketScore(score: number | null): RejectionScoreBand {
  if (score === null || !Number.isFinite(score)) return "unscored";
  if (score >= 4.5) return ">=4.5";
  if (score >= 4.0) return "4.0-4.4";
  return "3.5-3.9"; // clamp low end into the lowest named band
}

export function categorizeReason(reason: string): RejectionReasonCategory {
  const lc = reason.toLowerCase();
  for (const { category, tokens } of CATEGORY_KEYWORDS) {
    for (const t of tokens) {
      if (lc.includes(t)) return category;
    }
  }
  return "other";
}

export function aggregatePatterns(rows: RejectionRow[]): RejectionPatterns {
  // 1) keyword counts
  const keywordCounts = new Map<string, number>();
  for (const r of rows) {
    for (const k of extractKeywords(r.reason)) {
      keywordCounts.set(k, (keywordCounts.get(k) ?? 0) + 1);
    }
  }
  const topReasonKeywords: RejectionPatternKeyword[] = [...keywordCounts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, 15);

  // 2) categorized companies
  const byCategory = new Map<RejectionReasonCategory, Map<string, number>>();
  for (const r of rows) {
    const cat = categorizeReason(r.reason);
    let m = byCategory.get(cat);
    if (!m) {
      m = new Map();
      byCategory.set(cat, m);
    }
    if (!r.company) continue;
    m.set(r.company, (m.get(r.company) ?? 0) + 1);
  }
  const orderedCategories: RejectionReasonCategory[] = [
    "seniority", "comp", "location", "domain-fit", "skills", "culture", "other",
  ];
  const topCompaniesByReason: RejectionPatternCategory[] = [];
  for (const cat of orderedCategories) {
    const m = byCategory.get(cat);
    if (!m || m.size === 0) continue;
    const companies: RejectionPatternCompany[] = [...m.entries()]
      .map(([company, count]) => ({ company, count }))
      .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company))
      .slice(0, 5);
    topCompaniesByReason.push({ reasonCategory: cat, companies });
  }

  // 3) score bands (always emit all 4 bands so the UI sees zeroes)
  const bandCounts = new Map<RejectionScoreBand, number>();
  for (const b of ["3.5-3.9", "4.0-4.4", ">=4.5", "unscored"] as RejectionScoreBand[]) {
    bandCounts.set(b, 0);
  }
  for (const r of rows) {
    const b = bucketScore(r.score);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  }
  const scoreBands = [...bandCounts.entries()].map(([band, count]) => ({ band, count }));

  // 4) recent reasons (last 10 by ts desc)
  const recentReasons: RejectionRecentReason[] = [...rows]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, 10)
    .map((r) => ({
      ts: r.ts,
      company: r.company,
      role: r.role,
      score: r.score,
      reason: r.reason,
    }));

  return {
    totalRejections: rows.length,
    topReasonKeywords,
    topCompaniesByReason,
    scoreBands,
    recentReasons,
    generatedAt: new Date().toISOString(),
  };
}

export const rejectionPatternsPlugin: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  app.get<{ Reply: RejectionPatterns | { error: string } }>(
    "/api/rejections/patterns",
    async (_request, reply) => {
      try {
        const rows = loadRejections(REPO_ROOT);
        const patterns = aggregatePatterns(rows);
        return reply.code(200).send(patterns);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `failed to aggregate rejection patterns: ${message}` });
      }
    },
  );
};

export default rejectionPatternsPlugin;
