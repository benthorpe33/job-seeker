import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMutation,
  buildRowLine,
  parseTableLines,
  writeApplicationMutation,
  type ApplicationsMdRow,
} from "../api/writeback/applicationsMd.js";

const HEADER = `# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`;

function buildFixture(rows: number): string {
  const lines: string[] = [HEADER.trimEnd()];
  for (let i = 1; i <= rows; i++) {
    lines.push(
      `| ${i} | 2026-04-${String((i % 28) + 1).padStart(2, "0")} | Co${i} | Role${i} | ${(3 + (i % 20) / 10).toFixed(1)}/5 | Evaluated | ${i % 2 === 0 ? "✅" : "❌"} | [${String(i).padStart(3, "0")}](reports/${String(i).padStart(3, "0")}-co${i}-2026-04-29.md) | note ${i} |`,
    );
  }
  return lines.join("\n") + "\n";
}

function setup(content: string): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "js-writeback-"));
  const file = join(dir, "applications.md");
  writeFileSync(file, content);
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function diffLineCount(a: string, b: string): number {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  if (la.length !== lb.length) return Math.abs(la.length - lb.length) + 1;
  let n = 0;
  for (let i = 0; i < la.length; i++) {
    if (la[i] !== lb[i]) n++;
  }
  return n;
}

test("parseTableLines round-trip preserves ALL lines byte-for-byte", () => {
  const fixture = buildFixture(20);
  const { rows, lines, eol } = parseTableLines(fixture);
  assert.equal(rows.length, 20);
  assert.equal(eol, "\n");
  // Reconstruct: lines.join(eol) MUST equal the original.
  const reconstructed = lines.join(eol);
  assert.equal(reconstructed, fixture);
});

test("buildRowLine reproduces parsed raw line for typical fixture", () => {
  const fixture = buildFixture(5);
  const { rows } = parseTableLines(fixture);
  for (const r of rows) {
    assert.equal(buildRowLine(r), r.rawLine);
  }
});

test("applyMutation only changes target columns", () => {
  const fixture = buildFixture(3);
  const { rows } = parseTableLines(fixture);
  const target = rows[1] as ApplicationsMdRow;
  const updated = applyMutation(target, { num: target.num, status: "Applied", date: "2026-05-01" });
  assert.equal(updated.status, "Applied");
  assert.equal(updated.date, "2026-05-01");
  assert.equal(updated.company, target.company);
  assert.equal(updated.notes, target.notes);
});

test("writeApplicationMutation produces exactly 1 changed line per mutation, every row", () => {
  const fixture = buildFixture(20);
  for (let i = 1; i <= 20; i++) {
    const { file, cleanup } = setup(fixture);
    try {
      writeApplicationMutation(file, {
        num: i,
        status: "Applied",
        date: "2026-05-01",
      });
      const after = readFileSync(file, "utf-8");
      const diff = diffLineCount(fixture, after);
      assert.equal(diff, 1, `row ${i}: expected exactly 1 line changed, got ${diff}`);
      // The changed line must be the row matching #=i.
      const beforeLines = fixture.split(/\r?\n/);
      const afterLines = after.split(/\r?\n/);
      let changedIdx = -1;
      for (let j = 0; j < beforeLines.length; j++) {
        if (beforeLines[j] !== afterLines[j]) {
          changedIdx = j;
          break;
        }
      }
      assert.notEqual(changedIdx, -1);
      const newLine = afterLines[changedIdx] ?? "";
      assert.match(newLine, new RegExp(`^\\| ${i} \\| 2026-05-01 \\|.*\\| Applied \\|`));
    } finally {
      cleanup();
    }
  }
});

test("writeApplicationMutation preserves trailing newline + headers", () => {
  const fixture = buildFixture(5);
  const { file, cleanup } = setup(fixture);
  try {
    writeApplicationMutation(file, { num: 3, status: "Applied", date: "2026-05-01" });
    const after = readFileSync(file, "utf-8");
    assert.ok(after.startsWith("# Applications\n"));
    assert.ok(after.endsWith("\n"));
    // Header rows untouched.
    const lines = after.split("\n");
    assert.equal(lines[0], "# Applications");
    assert.equal(lines[1], "");
    assert.equal(lines[2], "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |");
    assert.equal(lines[3], "|---|------|---------|------|-------|--------|-----|--------|-------|");
  } finally {
    cleanup();
  }
});

test("writeApplicationMutation throws on missing num", () => {
  const fixture = buildFixture(3);
  const { file, cleanup } = setup(fixture);
  try {
    assert.throws(() => writeApplicationMutation(file, { num: 999, status: "Applied" }));
  } finally {
    cleanup();
  }
});

test("writeApplicationMutation no-op skips disk write when nothing changes", () => {
  const fixture = buildFixture(3);
  const { file, cleanup } = setup(fixture);
  try {
    const result = writeApplicationMutation(file, { num: 2 });
    const after = readFileSync(file, "utf-8");
    assert.equal(after, fixture);
    assert.equal(result.before.rawLine, result.after.rawLine);
  } finally {
    cleanup();
  }
});

test("CRLF fixture round-trips with CRLF preserved", () => {
  const fixture = buildFixture(3).replace(/\n/g, "\r\n");
  const { file, cleanup } = setup(fixture);
  try {
    writeApplicationMutation(file, { num: 2, status: "Applied", date: "2026-05-01" });
    const after = readFileSync(file, "utf-8");
    // CRLF preserved.
    assert.ok(after.includes("\r\n"));
    const diff = diffLineCount(fixture, after);
    assert.equal(diff, 1);
  } finally {
    cleanup();
  }
});

test("buildRowLine neutralizes a literal pipe so the row keeps 9 columns", () => {
  // Ramp ships titles like "Product Operations Specialist | Travel"; writing
  // one verbatim shifts score into the status column and breaks every reader.
  const line = buildRowLine({
    num: 42,
    date: "2026-09-23",
    company: "Ramp",
    role: "Product Operations Specialist | Travel",
    score: "1.6/5",
    status: "SKIP",
    pdf: "❌",
    report: "[876](reports/876-ramp-2026-09-23.md)",
    notes: "ops role | not a builder role",
  });
  assert.equal(line.split("|").length - 2, 9);
  const [row] = parseTableLines(`${HEADER}${line}\n`).rows;
  assert.ok(row);
  assert.equal(row.role, "Product Operations Specialist – Travel");
  assert.equal(row.score, "1.6/5");
  assert.equal(row.status, "SKIP");
  assert.equal(row.notes, "ops role – not a builder role");
});

test("applyMutation with a pipe in notes does not add a column", () => {
  const [row] = parseTableLines(buildFixture(1)).rows;
  assert.ok(row);
  const next = applyMutation(row, { num: row.num, notes: "recruiter said A | B" });
  assert.equal(next.rawLine.split("|").length - 2, 9);
  assert.equal(parseTableLines(`${HEADER}${next.rawLine}\n`).rows[0]?.notes, "recruiter said A – B");
});
