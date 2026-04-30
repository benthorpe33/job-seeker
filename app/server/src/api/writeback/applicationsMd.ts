import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquire, release } from "../../index/lock.js";

export type ApplicationsMdMutation = {
  num: number;
  status?: string;
  notes?: string;
  date?: string;
  pdf?: string;
  score?: string;
};

export type ApplicationsMdRow = {
  num: number;
  date: string;
  company: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
  rawLine: string;
  lineIndex: number;
};

export class ApplicationRowNotFoundError extends Error {
  constructor(num: number) {
    super(`Application row #${num} not found in applications.md`);
    this.name = "ApplicationRowNotFoundError";
  }
}

const SEPARATOR_RE = /^\|\s*-+\s*(\|\s*-+\s*)+\|\s*$/;
const HEADER_FIRST_CELL = /^#\s*$/;

function detectEol(content: string): "\r\n" | "\n" {
  // Use the first line break we see; fall back to LF.
  const idx = content.indexOf("\n");
  if (idx > 0 && content.charAt(idx - 1) === "\r") return "\r\n";
  return "\n";
}

export function splitTableRow(line: string): string[] | null {
  if (!line.startsWith("|")) return null;
  // Drop leading/trailing pipe + the wrapper empty cells.
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function isHeaderLine(parts: string[]): boolean {
  const first = parts[0] ?? "";
  return HEADER_FIRST_CELL.test(first);
}

function parseRow(rawLine: string, lineIndex: number): ApplicationsMdRow | null {
  if (!rawLine.startsWith("|")) return null;
  if (SEPARATOR_RE.test(rawLine.trimEnd())) return null;
  const parts = splitTableRow(rawLine.trimEnd());
  if (!parts || parts.length < 9) return null;
  if (isHeaderLine(parts)) return null;
  const numStr = parts[0] ?? "";
  if (!/^\d+$/.test(numStr)) return null;
  const [num, date, company, role, score, status, pdf, report, ...notesParts] = parts;
  return {
    num: Number.parseInt(num ?? "0", 10),
    date: date ?? "",
    company: company ?? "",
    role: role ?? "",
    score: score ?? "",
    status: status ?? "",
    pdf: pdf ?? "",
    report: report ?? "",
    notes: notesParts.join(" | ").trim(),
    rawLine,
    lineIndex,
  };
}

export function parseTableLines(content: string): {
  rows: ApplicationsMdRow[];
  lines: string[];
  eol: "\r\n" | "\n";
} {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const rows: ApplicationsMdRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const row = parseRow(lines[i] ?? "", i);
    if (row) rows.push(row);
  }
  return { rows, lines, eol };
}

export function buildRowLine(row: {
  num: number;
  date: string;
  company: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
}): string {
  return `| ${row.num} | ${row.date} | ${row.company} | ${row.role} | ${row.score} | ${row.status} | ${row.pdf} | ${row.report} | ${row.notes} |`;
}

export function applyMutation(row: ApplicationsMdRow, mut: ApplicationsMdMutation): ApplicationsMdRow {
  const next: ApplicationsMdRow = { ...row };
  if (mut.status !== undefined) next.status = mut.status;
  if (mut.notes !== undefined) next.notes = mut.notes;
  if (mut.date !== undefined) next.date = mut.date;
  if (mut.pdf !== undefined) next.pdf = mut.pdf;
  if (mut.score !== undefined) next.score = mut.score;
  next.rawLine = buildRowLine(next);
  return next;
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  // Create temp file in the same directory (same volume) so rename is atomic.
  const tmp = mkdtempSync(join(dir, ".applications-write-"));
  const tmpPath = join(tmp, "applications.md.tmp");
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, filePath);
  } finally {
    // Best-effort cleanup of the empty mkdtemp directory.
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export type WritebackResult = {
  before: ApplicationsMdRow;
  after: ApplicationsMdRow;
};

export function writeApplicationMutation(
  filePath: string,
  mut: ApplicationsMdMutation,
): WritebackResult {
  const original = readFileSync(filePath, "utf-8");
  const { rows, lines, eol } = parseTableLines(original);
  const target = rows.find((r) => r.num === mut.num);
  if (!target) {
    throw new ApplicationRowNotFoundError(mut.num);
  }
  const updated = applyMutation(target, mut);
  if (updated.rawLine === target.rawLine) {
    // No-op write; still acquire a lock to keep semantics symmetric, but
    // skip the disk write entirely.
    return { before: target, after: updated };
  }
  const newLines = lines.slice();
  newLines[target.lineIndex] = updated.rawLine;
  const newContent = newLines.join(eol);

  acquire(filePath);
  try {
    atomicWrite(filePath, newContent);
  } catch (err) {
    release(filePath);
    throw err;
  }
  // Lock auto-expires after TTL (2s) — gives the watcher a chance to ignore
  // the change-event our own write triggered, then naturally clears.
  return { before: target, after: updated };
}

export function readApplicationsMd(filePath: string): ApplicationsMdRow[] {
  const content = readFileSync(filePath, "utf-8");
  return parseTableLines(content).rows;
}
