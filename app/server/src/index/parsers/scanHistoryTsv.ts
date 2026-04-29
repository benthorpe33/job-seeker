export type ParsedScanRow = {
  url: string | null;
  firstSeen: string | null;
  portal: string | null;
  title: string | null;
  company: string | null;
  status: string | null;
};

export function parseScanHistoryTsv(content: string): ParsedScanRow[] {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headerLine = lines[0] ?? "";
  const headers = headerLine.split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string): number => headers.indexOf(name);
  const iUrl = idx("url");
  const iFirst = idx("first_seen");
  const iPortal = idx("portal");
  const iTitle = idx("title");
  const iCompany = idx("company");
  const iStatus = idx("status");

  const get = (cells: string[], i: number): string | null =>
    i >= 0 && i < cells.length ? cells[i] ?? null : null;

  const out: ParsedScanRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? "").split("\t");
    out.push({
      url: get(cells, iUrl),
      firstSeen: get(cells, iFirst),
      portal: get(cells, iPortal),
      title: get(cells, iTitle),
      company: get(cells, iCompany),
      status: get(cells, iStatus),
    });
  }
  return out;
}
