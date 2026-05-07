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
    let path = url.pathname.replace(/\/+$/, "");
    // js-x7v: Ashby exposes the same posting at /{slug}/{uuid} and
    // /{slug}/{uuid}/application. Strip the apply-form suffix so dedup
    // catches it when one report's URL is the canonical form and the
    // other is the apply-form deeplink.
    if (host.endsWith("ashbyhq.com")) {
      path = path.replace(/\/application$/, "");
    }
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
    // Capture only the URL token (first non-whitespace run after `**URL:**`).
    // Older reports had `**URL:** <url>` alone on a line; newer reports
    // append ` · **PDF:** ❌ ...` after the URL on the same line. The earlier
    // greedy `(\S.*?)` captured the whole tail and broke normalizeUrl, which
    // silently disabled the dedup for the new format.
    const m = head.match(/^\*\*URL:\*\*\s+(\S+)/m);
    if (!m) continue;
    const norm = normalizeUrl(m[1]);
    if (norm) set.add(norm);
  }
  return set;
}
