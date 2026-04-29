export type ParsedPipelineEntry = {
  url: string;
  company: string | null;
  role: string | null;
  location: string | null;
  checked: number;
};

const ROW_RE = /^-\s*\[( |x|X)\]\s+(.+)$/;

export function parsePipelineMd(content: string): ParsedPipelineEntry[] {
  const out: ParsedPipelineEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const m = rawLine.match(ROW_RE);
    if (!m || m[2] === undefined) continue;
    const checked = (m[1] ?? "").toLowerCase() === "x" ? 1 : 0;
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length === 0) continue;
    const url = parts[0] ?? "";
    if (!url) continue;
    const company = parts.length > 1 ? (parts[1] ?? null) : null;
    const role = parts.length > 2 ? (parts[2] ?? null) : null;
    // Location may itself contain ` | ` separators (multi-city listings).
    // Re-join everything after part 3 with " | ".
    const location =
      parts.length > 3 ? parts.slice(3).join(" | ").trim() || null : null;
    out.push({ url, company, role, location, checked });
  }
  return out;
}
