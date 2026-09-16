// Shared parsing of LinkedIn saved-job card text into { title, company, location }.
//
// Used by:
//   - scripts/linkedin-saved-jobs.mjs     (Stage 1 — writes structured fields)
//   - scripts/resolve-ats-urls.mjs        (Stage 2 — dedup + result rows)
//   - scripts/append-to-pipeline.mjs      (Stage 3 — pipeline.md lines)
//   - scripts/preview-pipeline-append.mjs (dry-run preview of Stage 3)
//
// Card layouts seen so far:
//   - jobs-tracker (2026-09): one <p> per line —
//       ["Applied AI Engineer", "Snorkel AI · New York, NY (Hybrid)", "Reposted 2w ago"]
//   - my-items/saved-jobs (legacy): title, optional ", Verified" badge, company,
//       location, e.g. ["Applied AI Engineer", ", Verified", "Snorkel AI", "New York, NY (Hybrid)"]

const WORKPLACE_RE = /\((On-site|Hybrid|Remote)\)/i;
const POSTED_RE = /^(re)?posted\b|\bago$/i;
const BADGE_RE = /^,?\s*(Verified|Promoted|Actively recruiting|Easy Apply)\b/i;

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

export function parseCardLines(lines) {
  const ls = (lines || []).map(clean).filter(Boolean);
  const out = { title: '', company: '', location: '', workplaceType: '', postedText: '' };
  if (ls.length === 0) return out;

  out.postedText = ls.find((l) => POSTED_RE.test(l)) || '';

  const dotIdx = ls.findIndex((l) => l.includes(' · '));
  if (dotIdx === 0) {
    // Title and company ran together in one string ("Data Scientist Acme · NYC");
    // the boundary can't be recovered, so leave both empty rather than guess.
    return out;
  }
  if (dotIdx > 0) {
    const [company, ...rest] = ls[dotIdx].split(' · ');
    out.company = clean(company);
    out.location = clean(rest.join(' · '));
    out.title = ls.slice(0, dotIdx).find((l) => !BADGE_RE.test(l) && !POSTED_RE.test(l)) || '';
  } else {
    out.title = ls[0];
    const rest = ls.slice(1).filter((l) => !BADGE_RE.test(l) && !POSTED_RE.test(l));
    out.location = rest.find((l) => WORKPLACE_RE.test(l)) || '';
    out.company = rest.find((l) => l !== out.location) || '';
  }

  const wp = out.location.match(WORKPLACE_RE);
  out.workplaceType = wp ? wp[1] : '';
  return out;
}

// Structured fields from a linkedin-saved-jobs.json row. Prefers the fields
// Stage 1 writes; falls back to re-parsing cardText for files written by older
// versions of the scraper.
export function savedJobFields(job) {
  if (!job) return { title: '', company: '', location: '' };
  const parsed = parseCardLines(job.cardText);
  return {
    title: clean(job.title && job.company ? job.title : parsed.title || job.title),
    company: clean(job.company || parsed.company),
    location: clean(job.location || parsed.location),
  };
}
