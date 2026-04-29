export type ParsedReport = {
  id: string;
  num: number | null;
  slug: string;
  date: string | null;
  url: string | null;
  score: number | null;
  legitimacy: string | null;
  verification: string | null;
  blocks: Record<string, string>;
  bodyMd: string;
  fileMtime: number;
};

const FILENAME_RE = /^(\d{1,4})-(.+)-(\d{4}-\d{2}-\d{2})\.md$/;

function extractField(text: string, key: string): string | null {
  // Match `**Key:** value` up to end of line or to ` · **NextKey:**`.
  const re = new RegExp(
    `\\*\\*${key}:\\*\\*\\s*([^\\n]*?)(?=\\s*·\\s*\\*\\*|$)`,
    "m",
  );
  const m = text.match(re);
  if (!m || m[1] === undefined) return null;
  const v = m[1].trim();
  return v.length === 0 ? null : v;
}

function parseScore(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseBlocks(content: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  // `## A) Title` through end-of-block (next `## ` or EOF).
  const re = /^##\s+([A-G])\)\s+([^\n]*)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    if (!key) continue;
    blocks[key] = (m[3] ?? "").trim();
  }
  return blocks;
}

function deriveIdAndParts(filename: string): {
  id: string;
  num: number | null;
  slug: string;
  date: string | null;
} {
  const id = filename.replace(/\.md$/, "");
  const m = filename.match(FILENAME_RE);
  if (!m) {
    return { id, num: null, slug: id, date: null };
  }
  const numStr = m[1] ?? "";
  const slug = m[2] ?? "";
  const date = m[3] ?? null;
  const num = numStr ? Number.parseInt(numStr, 10) : null;
  return { id, num, slug, date };
}

export function parseReportMd(
  filename: string,
  content: string,
  fileMtime: number,
): ParsedReport {
  const { id, num, slug, date } = deriveIdAndParts(filename);
  // Header window: only look at the first ~25 lines so a `**Score:** X/5`
  // appearing inside Block D can never overwrite the header score.
  const head = content.split(/\r?\n/).slice(0, 25).join("\n");
  return {
    id,
    num,
    slug,
    date,
    url: extractField(head, "URL"),
    score: parseScore(extractField(head, "Score")),
    legitimacy: extractField(head, "Legitimacy"),
    verification: extractField(head, "Verification"),
    blocks: parseBlocks(content),
    bodyMd: content,
    fileMtime,
  };
}
