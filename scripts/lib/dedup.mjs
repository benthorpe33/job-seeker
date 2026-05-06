// Shared company+role fuzzy dedup for the LinkedIn pipeline.
//
// Used by:
//   - scripts/resolve-ats-urls.mjs        (Stage 2 — pre-Playwright filter)
//   - scripts/append-to-pipeline.mjs      (Stage 3 — append to pipeline.md)
//   - scripts/preview-pipeline-append.mjs (dry-run preview of Stage 3)
//
// Convergence notes:
//   - One canonical stopword list (wide superset of the two it replaced).
//     A wider list strips MORE generic tokens from the role comparison,
//     leaving FEWER tokens to match — strictly more conservative dedup
//     (less likely to call two different roles a duplicate).
//   - normalizeRole strips parenthetical content (e.g. "(Remote)") before
//     comparing. resolve-ats-urls already did this; append/preview now do
//     too. In practice cardText puts mode tags in a separate slot, so this
//     rarely fires.
//   - Each call site passes opts to keep its established threshold
//     (resolve=3, append/preview=2) and substring-company-match
//     (off for resolve, on for append/preview).

const STOPWORDS = new Set([
  "senior", "staff", "principal", "lead", "engineer", "scientist",
  "data", "ai", "ml", "machine", "learning", "analytics", "product",
  "forward", "deployed", "applied", "solutions", "architect",
  "analyst", "developer", "software", "technical", "member",
  "and", "the", "for",
]);

export function normalizeCompany(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeRole(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function roleTokens(role) {
  return new Set(
    normalizeRole(role).split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

// applications.md format: | # | Date | Company | Role | Score | Status | ...
export function parseApplicationsRows(md) {
  const rows = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|---") || /\|\s*#\s*\|/.test(line)) continue;
    const c = line.split("|").map((x) => x.trim());
    if (c.length < 5 || !c[3] || !c[4]) continue;
    rows.push({ company: c[3], role: c[4] });
  }
  return rows;
}

// pipeline.md format: - [ ] URL | Company | Role | Location?
export function parsePipelineRows(md) {
  const rows = [];
  for (const line of md.split("\n")) {
    if (!/^- \[[ x]\]/.test(line)) continue;
    const parts = line.replace(/^- \[[ x]\]\s*/, "").split(" | ");
    if (parts.length < 3) continue;
    rows.push({
      url: parts[0].trim(),
      company: parts[1]?.trim() || "",
      role: parts[2]?.trim() || "",
    });
  }
  return rows;
}

// Fuzzy "are these two postings the same posting" check.
// Returns true on exact normalized company+role, OR same-company + >=threshold
// shared non-stopword role tokens. Pass substringCompany=true to let
// "Anthropic" match "Anthropic Inc".
export function looksLikeDuplicate(a, b, opts = {}) {
  const threshold = opts.threshold ?? 3;
  const substringCompany = opts.substringCompany ?? false;
  const ac = normalizeCompany(a.company);
  const bc = normalizeCompany(b.company);
  if (!ac || !bc) return false;
  const sameCompany = substringCompany
    ? ac === bc || ac.includes(bc) || bc.includes(ac)
    : ac === bc;
  if (!sameCompany) return false;
  if (normalizeRole(a.role) === normalizeRole(b.role)) return true;
  const at = roleTokens(a.role);
  const bt = roleTokens(b.role);
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared += 1;
  return shared >= threshold;
}
