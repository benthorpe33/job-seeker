import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { PersistedJob } from "@job-seeker/shared";

export async function loadJobsFile(path: string): Promise<PersistedJob[]> {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PersistedJob[] = [];
  for (const entry of parsed) {
    if (!isPersistedJob(entry)) continue;
    out.push(entry);
  }
  return out;
}

export async function saveJobsFile(
  path: string,
  jobs: PersistedJob[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(jobs), "utf-8");
  await rename(tmp, path);
}

function isPersistedJob(x: unknown): x is PersistedJob {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.jobId !== "string") return false;
  if (typeof o.kind !== "string") return false;
  if (typeof o.startedAt !== "string") return false;
  if (typeof o.startedAtMs !== "number") return false;
  if (
    o.status !== "completed" &&
    o.status !== "failed" &&
    o.status !== "cancelled" &&
    o.status !== "running"
  ) {
    return false;
  }
  if (!Array.isArray(o.ring)) return false;
  return true;
}
