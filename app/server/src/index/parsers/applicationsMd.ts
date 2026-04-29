export type ParsedApplication = {
  num: number | null;
  date: string | null;
  company: string;
  role: string;
  score: number | null;
  status: string;
  hasPdf: number;
  reportPath: string | null;
  notes: string;
  rawLine: string;
};

const STATUS_ALIASES: Record<string, string> = {
  evaluada: "Evaluated",
  evaluated: "Evaluated",
  applied: "Applied",
  aplicado: "Applied",
  aplicada: "Applied",
  enviada: "Applied",
  sent: "Applied",
  responded: "Responded",
  respondido: "Responded",
  interview: "Interview",
  entrevista: "Interview",
  offer: "Offer",
  oferta: "Offer",
  rejected: "Rejected",
  rechazado: "Rejected",
  rechazada: "Rejected",
  discarded: "Discarded",
  descartado: "Discarded",
  descartada: "Discarded",
  cerrada: "Discarded",
  cancelada: "Discarded",
  skip: "SKIP",
  no_aplicar: "SKIP",
  "no aplicar": "SKIP",
  monitor: "SKIP",
};

function normalizeStatus(raw: string): string {
  const stripped = raw.replace(/\*/g, "").trim().toLowerCase();
  return STATUS_ALIASES[stripped] ?? raw.replace(/\*/g, "").trim();
}

function parseScore(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseReportPath(raw: string): string | null {
  const m = raw.match(/\((reports\/[^\s)]+\.md)\)/);
  return m && m[1] ? m[1] : null;
}

function isHeaderOrSeparator(cells: string[]): boolean {
  const first = cells[0]?.trim() ?? "";
  if (first === "#") return true;
  if (/^-+$/.test(first)) return true;
  return false;
}

export function parseApplicationsMd(content: string): ParsedApplication[] {
  const out: ParsedApplication[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("|")) continue;
    // Split on `|` and drop the empty first/last cells from leading/trailing pipes.
    const parts = line.split("|").slice(1, -1).map((c) => c.trim());
    if (parts.length < 9) continue;
    if (isHeaderOrSeparator(parts)) continue;
    const numStr = parts[0] ?? "";
    if (!/^\d+$/.test(numStr)) continue;

    const [
      numCell,
      dateCell,
      companyCell,
      roleCell,
      scoreCell,
      statusCell,
      pdfCell,
      reportCell,
      ...notesParts
    ] = parts;

    out.push({
      num: Number.parseInt(numCell ?? "0", 10),
      date: dateCell ?? null,
      company: companyCell ?? "",
      role: roleCell ?? "",
      score: parseScore(scoreCell ?? ""),
      status: normalizeStatus(statusCell ?? ""),
      hasPdf: (pdfCell ?? "").includes("✅") ? 1 : 0,
      reportPath: parseReportPath(reportCell ?? ""),
      notes: notesParts.join(" | ").trim(),
      rawLine,
    });
  }
  return out;
}
