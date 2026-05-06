// Shared helpers for "URL is already in reports/*.md" dedup.
//
// Used by:
//   - scripts/resolve-ats-urls.mjs  (Stage 2 — skip Playwright when a cached
//                                   ATS URL is already reported)
//   - scripts/filter-batch-input.mjs (Stage 5 — backstop when Stage 2 didn't
//                                    catch it: first-run / non-cached / etc.)
//
// CRITICAL: both call sites MUST normalize URLs the same way, or the dedup
// silently misses. Keep this module the single source of truth.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function normalizeUrl(u) {
  if (typeof u !== "string") return "";
  const trimmed = u.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function loadEvaluatedUrls(reportsDir = "reports") {
  const set = new Set();
  let entries;
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return set; // no reports yet
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(reportsDir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const text = readFileSync(path, "utf-8");
    // Only scan the first ~30 lines — header is always near the top.
    const head = text.split(/\r?\n/, 30).join("\n");
    const m = head.match(/^\*\*URL:\*\*\s+(\S.*?)\s*$/m);
    if (!m) continue;
    const norm = normalizeUrl(m[1]);
    if (norm) set.add(norm);
  }
  return set;
}
