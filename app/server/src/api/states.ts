import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../env.js";

let cached: { labels: string[]; loadedAt: number } | null = null;

export function loadCanonicalStates(repoRoot: string = REPO_ROOT): string[] {
  if (cached && Date.now() - cached.loadedAt < 60_000) return cached.labels;
  const path = join(repoRoot, "templates", "states.yml");
  const raw = readFileSync(path, "utf-8");
  // Lightweight YAML reader: extract every `label: X` line. The states.yml
  // file is short and stable; pulling in a YAML library for one field would
  // be overkill.
  const labels: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*-?\s*label:\s*(.+?)\s*$/);
    if (m && m[1]) labels.push(m[1]);
  }
  cached = { labels, loadedAt: Date.now() };
  return labels;
}

export function isCanonicalStatus(status: string, repoRoot: string = REPO_ROOT): boolean {
  const labels = loadCanonicalStates(repoRoot);
  return labels.includes(status);
}
