import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../env.js";

const HEADER = "ts\tapplication_id\tcompany\trole\tscore\treason";

export type RejectionRecord = {
  applicationId: number;
  company: string;
  role: string;
  score: number | null;
  reason: string;
};

function escapeTab(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function appendRejection(rec: RejectionRecord, repoRoot: string = REPO_ROOT): void {
  const path = join(repoRoot, "data", "rejection-feedback.tsv");
  const ts = new Date().toISOString();
  const line = [
    ts,
    String(rec.applicationId),
    escapeTab(rec.company),
    escapeTab(rec.role),
    rec.score === null ? "" : rec.score.toFixed(1),
    escapeTab(rec.reason),
  ].join("\t");
  if (!existsSync(path)) {
    writeFileSync(path, `${HEADER}\n${line}\n`);
    return;
  }
  appendFileSync(path, `${line}\n`);
}
