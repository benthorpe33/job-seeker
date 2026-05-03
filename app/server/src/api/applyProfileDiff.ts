import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { applyPatch, parsePatch } from "diff";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type {
  ApplyProfileDiffRequest,
  ApplyProfileDiffResponse,
  ProfileDiffDraftStartResponse,
} from "@job-seeker/shared";

import { REPO_ROOT } from "../env.js";
import { acquire, release } from "../index/lock.js";
import { resolveKind } from "../jobs/kinds.js";
import { spawnJob } from "../jobs/runner.js";
import { aggregatePatterns, loadRejections } from "./rejectionsPatterns.js";

const PROFILE_REL = "modes/_profile.md";
const SHARED_REL = "modes/_shared.md";

function stripDiffPrefix(name: string | undefined): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (trimmed.startsWith("a/")) return trimmed.slice(2);
  if (trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmp = mkdtempSync(join(dir, ".profile-write-"));
  const tmpPath = join(tmp, "_profile.md.tmp");
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
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export const profileDiffPlugin: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  app.post<{ Reply: ProfileDiffDraftStartResponse | { error: string } }>(
    "/api/rejections/draft-profile-diff",
    async (_request, reply) => {
      // 1) build patterns + a snapshot the worker can read
      const rows = loadRejections(REPO_ROOT);
      const patterns = aggregatePatterns(rows);

      const profileAbs = join(REPO_ROOT, PROFILE_REL);
      let profileMd = "";
      try {
        profileMd = readFileSync(profileAbs, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `failed to read modes/_profile.md: ${message}` });
      }

      const tmpDir = join(REPO_ROOT, "data", ".tmp");
      try {
        mkdirSync(tmpDir, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `failed to create tmp dir: ${message}` });
      }

      const patternsPath = join(tmpDir, `profile-patterns-${randomUUID()}.json`);
      try {
        writeFileSync(
          patternsPath,
          JSON.stringify({ patterns, profileMd, profilePath: profileAbs }, null, 2),
          "utf-8",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `failed to write patterns file: ${message}` });
      }

      const bashPath = app.jobsBashPath;
      const resolved = resolveKind("profile-diff-draft", [patternsPath], bashPath !== null);
      if ("ok" in resolved) {
        return reply.code(resolved.status).send({ error: resolved.message });
      }
      const cmd = bashPath ?? resolved.cmd;
      const job = spawnJob({
        kind: "profile-diff-draft",
        cmd,
        args: resolved.args,
        cwd: REPO_ROOT,
        env: process.env,
        registry: app.jobs,
      });

      return reply.code(200).send({
        jobId: job.jobId,
        kind: job.kind,
        startedAt: job.startedAt,
      });
    },
  );

  app.post<{
    Body: Partial<ApplyProfileDiffRequest>;
    Reply: ApplyProfileDiffResponse | { error: string };
  }>("/api/rejections/apply-diff", async (request, reply) => {
    const body = request.body ?? {};
    const diff = typeof body.diff === "string" ? body.diff : "";
    if (!diff.trim()) {
      return reply.code(400).send({ error: "body.diff must be a non-empty string" });
    }

    let patches;
    try {
      patches = parsePatch(diff);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `failed to parse diff: ${message}` });
    }
    if (!Array.isArray(patches) || patches.length !== 1) {
      return reply.code(400).send({
        error: `diff must contain exactly one file patch (got ${patches?.length ?? 0})`,
      });
    }
    const patch = patches[0];
    if (!patch) {
      return reply.code(400).send({ error: "diff parsed to an empty patch" });
    }
    const oldName = stripDiffPrefix(patch.oldFileName);
    const newName = stripDiffPrefix(patch.newFileName);
    if (oldName !== PROFILE_REL || newName !== PROFILE_REL) {
      return reply.code(400).send({
        error: `diff must touch only ${PROFILE_REL} (got old=${patch.oldFileName ?? "?"} new=${patch.newFileName ?? "?"})`,
      });
    }

    const profileAbs = join(REPO_ROOT, PROFILE_REL);
    const sharedAbs = join(REPO_ROOT, SHARED_REL);

    let sharedMtimeBefore: number;
    try {
      sharedMtimeBefore = statSync(sharedAbs).mtimeMs;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to stat ${SHARED_REL}: ${message}` });
    }

    let current: string;
    try {
      current = readFileSync(profileAbs, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to read ${PROFILE_REL}: ${message}` });
    }

    const next = applyPatch(current, patch);
    if (next === false) {
      return reply.code(400).send({ error: "patch did not apply cleanly to modes/_profile.md" });
    }

    acquire(profileAbs);
    try {
      atomicWrite(profileAbs, next);
    } catch (err) {
      release(profileAbs);
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to write ${PROFILE_REL}: ${message}` });
    }
    // Lock auto-expires after TTL (2s) so the watcher ignores our own write.

    let sharedMtimeAfter: number;
    try {
      sharedMtimeAfter = statSync(sharedAbs).mtimeMs;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to re-stat ${SHARED_REL}: ${message}` });
    }
    if (sharedMtimeAfter !== sharedMtimeBefore) {
      return reply.code(500).send({
        error: `shared file ${SHARED_REL} was mutated unexpectedly during apply`,
      });
    }

    return reply.code(200).send({
      ok: true,
      bytesWritten: Buffer.byteLength(next, "utf-8"),
      sharedMtimeUnchanged: true,
    });
  });
};

export default profileDiffPlugin;
