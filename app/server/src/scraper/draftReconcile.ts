import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DraftAnswer, DraftFile } from "@job-seeker/shared";

import type { Job } from "../jobs/registry.js";

const DRAFT_LINE_PREFIX = "DRAFT: ";
const DONE_LINE_PREFIX = "DRAFT_ANSWERS_DONE:";
const FAILED_LINE_PREFIX = "DRAFT_ANSWERS_FAILED:";
const PHONE_REGEX = /\d{3}-\d{3}-\d{4}/g;
const PHONE_REDACTION = "[PHONE REDACTED]";

export type DraftReconcileLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
};

export function parseDraftLines(stdoutLines: readonly string[]): DraftAnswer[] {
  const out: DraftAnswer[] = [];
  for (const raw of stdoutLines) {
    if (!raw.startsWith(DRAFT_LINE_PREFIX)) continue;
    const payload = raw.slice(DRAFT_LINE_PREFIX.length).trim();
    if (!payload) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const fieldId = typeof obj.fieldId === "string" ? obj.fieldId : null;
    const answer = typeof obj.answer === "string" ? obj.answer : null;
    if (!fieldId || answer === null) continue;
    const charCountVal =
      typeof obj.charCount === "number" && Number.isFinite(obj.charCount)
        ? Math.trunc(obj.charCount)
        : answer.length;
    const warnings = Array.isArray(obj.warnings)
      ? obj.warnings.filter((w): w is string => typeof w === "string")
      : [];
    out.push({
      fieldId,
      answer,
      charCount: charCountVal,
      warnings,
    });
  }
  return out;
}

export function extractFailureReason(stdoutLines: readonly string[]): string | null {
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const line = stdoutLines[i] ?? "";
    if (line.startsWith(FAILED_LINE_PREFIX)) {
      return line.slice(FAILED_LINE_PREFIX.length).trim();
    }
  }
  return null;
}

export function extractDoneCount(stdoutLines: readonly string[]): number | null {
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const line = stdoutLines[i] ?? "";
    if (line.startsWith(DONE_LINE_PREFIX)) {
      const rest = line.slice(DONE_LINE_PREFIX.length).trim();
      const n = Number.parseInt(rest, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// Defense-in-depth: even though the prompt forbids it, redact any phone number
// the worker might have leaked into a drafted answer and append a warning.
// Returns a new DraftAnswer; does not mutate the input.
export function redactPhoneFromAnswer(d: DraftAnswer): DraftAnswer {
  if (!PHONE_REGEX.test(d.answer)) {
    PHONE_REGEX.lastIndex = 0;
    return d;
  }
  PHONE_REGEX.lastIndex = 0;
  const redacted = d.answer.replace(PHONE_REGEX, PHONE_REDACTION);
  const warnings = [...d.warnings, "phone-number-detected; redacted"];
  return {
    fieldId: d.fieldId,
    answer: redacted,
    charCount: redacted.length,
    warnings,
  };
}

export function draftsPathFor(repoRoot: string, reportId: string): string {
  return join(repoRoot, "data", "applications", reportId, "drafts.json");
}

export function fieldsPathFor(repoRoot: string, reportId: string): string {
  return join(repoRoot, "data", "applications", reportId, ".draft-fields.json");
}

export function writeDraftsFile(
  filePath: string,
  reportId: string,
  applyUrl: string | null,
  drafts: DraftAnswer[],
): DraftFile {
  const file: DraftFile = {
    reportId,
    applyUrl,
    generatedAt: new Date().toISOString(),
    drafts,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8");
  return file;
}

export function readDraftsFile(filePath: string): DraftFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.reportId !== "string") return null;
  if (!Array.isArray(obj.drafts)) return null;
  const drafts: DraftAnswer[] = [];
  for (const d of obj.drafts) {
    if (!d || typeof d !== "object") continue;
    const dd = d as Record<string, unknown>;
    if (typeof dd.fieldId !== "string" || typeof dd.answer !== "string") continue;
    drafts.push({
      fieldId: dd.fieldId,
      answer: dd.answer,
      charCount:
        typeof dd.charCount === "number" && Number.isFinite(dd.charCount)
          ? Math.trunc(dd.charCount)
          : (dd.answer as string).length,
      warnings: Array.isArray(dd.warnings)
        ? dd.warnings.filter((w): w is string => typeof w === "string")
        : [],
    });
  }
  return {
    reportId: obj.reportId,
    applyUrl: typeof obj.applyUrl === "string" ? obj.applyUrl : null,
    generatedAt:
      typeof obj.generatedAt === "string" ? obj.generatedAt : new Date(0).toISOString(),
    drafts,
  };
}

export type RegisterDraftReconcileOpts = {
  job: Job;
  reportId: string;
  applyUrl: string | null;
  draftsPath: string;
  fieldsFilePath: string | null;
  log?: DraftReconcileLogger;
};

export function registerDraftReconcileHook(opts: RegisterDraftReconcileOpts): void {
  const { job, reportId, applyUrl, draftsPath, fieldsFilePath, log } = opts;
  job.emitter.once("done", (ev: { code: number | null; status: string }) => {
    try {
      // Always best-effort clean up the temp fields file we wrote pre-spawn,
      // success or failure. The worker has already finished reading it.
      if (fieldsFilePath) {
        try {
          unlinkSync(resolve(fieldsFilePath));
        } catch {
          // ignore — file may already be gone
        }
      }

      if (ev.status !== "completed" || ev.code !== 0) {
        const stderr = job.ring
          .filter((e) => e.stream === "stderr")
          .map((e) => e.line);
        const failureReason = extractFailureReason(
          job.ring.filter((e) => e.stream === "stdout").map((e) => e.line),
        );
        const detail = failureReason ?? stderr[stderr.length - 1] ?? "(no detail)";
        log?.warn(
          `draft-answers: job ${job.jobId} ended status=${ev.status} code=${ev.code} reason=${detail}`,
        );
        return;
      }

      const stdoutLines = job.ring
        .filter((e) => e.stream === "stdout")
        .map((e) => e.line);

      const rawDrafts = parseDraftLines(stdoutLines);
      if (rawDrafts.length === 0) {
        log?.warn(
          `draft-answers: job ${job.jobId} exited 0 but emitted no DRAFT: lines; not writing drafts.json`,
        );
        return;
      }

      const safeDrafts = rawDrafts.map(redactPhoneFromAnswer);
      const phoneRedactions = safeDrafts.filter((d) =>
        d.warnings.includes("phone-number-detected; redacted"),
      ).length;

      const file = writeDraftsFile(draftsPath, reportId, applyUrl, safeDrafts);
      log?.info(
        `draft-answers: wrote ${file.drafts.length} answer(s) to ${draftsPath}` +
          (phoneRedactions > 0
            ? ` (${phoneRedactions} phone-number redaction(s))`
            : ""),
      );
    } catch (err) {
      log?.error("draft-answers: failed to reconcile drafts.json", err);
    }
  });
}
