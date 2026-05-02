import { createHash } from "node:crypto";

import type { Browser } from "playwright";

import { isPiiLabel } from "../pii.js";
import type { ParsedHandle, ScrapeResult, ScrapedField } from "../types.js";

const PATH_RE = /\/(?:embed\/job_app\?for=|jobs\/)([^/?#]+)/i;

export function parseGreenhouseHandle(applyUrl: string): ParsedHandle | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (!host.endsWith("greenhouse.io")) return null;

  // Two main URL forms:
  //   https://boards.greenhouse.io/{slug}/jobs/{id}
  //   https://job-boards.greenhouse.io/{slug}/jobs/{id}
  //   https://{customer}.greenhouse.io/...     (rare; slug derived from subdomain)
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  // Path-based parse first.
  if (segments.length >= 3 && segments[1] === "jobs") {
    return { slug: segments[0]!, jobId: segments[2]! };
  }
  // Embed-style ?for=slug + ?gh_jid=id (sometimes seen as embed_v2)
  const slugQuery = url.searchParams.get("for");
  const idQuery = url.searchParams.get("gh_jid");
  if (slugQuery && idQuery) {
    return { slug: slugQuery, jobId: idQuery };
  }
  // Fallback: try regex over the path
  const m = PATH_RE.exec(url.pathname);
  if (m && idQuery) {
    return { slug: m[1]!, jobId: idQuery };
  }
  return null;
}

type GreenhouseQuestion = {
  label?: string;
  required?: boolean;
  fields?: Array<{
    name?: string;
    type?: string;
    values?: unknown;
  }>;
};

type GreenhouseQuestionsResponse = {
  questions?: GreenhouseQuestion[];
};

function stableId(prefix: string, label: string): string {
  return `${prefix}-${createHash("sha1").update(label).digest("hex").slice(0, 10)}`;
}

function mapApiQuestion(q: GreenhouseQuestion, idx: number): ScrapedField | null {
  const label = (q.label ?? "").trim();
  if (!label) return null;

  const field = (q.fields ?? [])[0];
  const rawType = (field?.type ?? "").toLowerCase();

  // Greenhouse field types include: input_text, textarea, attachment,
  // multi_value_single_select, multi_value_multi_select, etc.
  // We only handle free-text questions; anything else (file uploads,
  // selects) is skipped at the API layer.
  let type: "text" | "textarea";
  if (rawType === "textarea" || rawType === "long_text") {
    type = "textarea";
  } else if (rawType === "input_text" || rawType === "short_text" || rawType === "text") {
    type = "text";
  } else {
    return null;
  }

  return {
    id: field?.name ?? stableId(`gh-${idx}`, label),
    label,
    type,
    required: q.required === true,
  };
}

export async function fetchGreenhouseApi(
  handle: ParsedHandle,
): Promise<ScrapedField[] | null> {
  // The questions array hangs off the standard job endpoint behind
  // ?questions=true. The /questions sub-path returns a generic HTML page,
  // not JSON, even with status 200.
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
    handle.slug,
  )}/jobs/${encodeURIComponent(handle.jobId)}?questions=true`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;

  let json: GreenhouseQuestionsResponse;
  try {
    json = (await res.json()) as GreenhouseQuestionsResponse;
  } catch {
    return null;
  }
  const questions = json.questions;
  if (!Array.isArray(questions)) return null;

  const fields: ScrapedField[] = [];
  for (let i = 0; i < questions.length; i++) {
    const mapped = mapApiQuestion(questions[i]!, i);
    if (!mapped) continue;
    if (isPiiLabel(mapped.label)) continue;
    fields.push(mapped);
  }
  return fields;
}

type DomField = {
  id: string;
  label: string;
  type: "text" | "textarea";
  required: boolean;
  maxLen: number | null;
};

export async function scrapeGreenhouseDom(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapedField[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    const raw = await page.evaluate(() => {
      const container = document.querySelector("#application_form, form#application_form, form");
      if (!container) return [] as DomField[];
      const out: DomField[] = [];
      const inputs = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input[type='text'], textarea",
      );
      inputs.forEach((el, idx) => {
        const id = el.id || el.name || `gh-dom-${idx}`;
        let labelText = "";
        if (el.id) {
          const lab = container.querySelector(`label[for='${CSS.escape(el.id)}']`);
          if (lab) labelText = (lab.textContent ?? "").trim();
        }
        if (!labelText) {
          const wrap = el.closest("label");
          if (wrap) labelText = (wrap.textContent ?? "").trim();
        }
        if (!labelText) {
          const wrap = el.closest("[class*='field']");
          const lab = wrap?.querySelector("label");
          if (lab) labelText = (lab.textContent ?? "").trim();
        }
        const required =
          el.required || el.getAttribute("aria-required") === "true";
        const maxLenAttr = el.getAttribute("maxlength");
        const maxLen = maxLenAttr ? Number.parseInt(maxLenAttr, 10) : null;
        out.push({
          id,
          label: labelText,
          type: el.tagName.toLowerCase() === "textarea" ? "textarea" : "text",
          required,
          maxLen: Number.isFinite(maxLen) ? maxLen : null,
        });
      });
      return out;
    });

    const fields: ScrapedField[] = [];
    for (const f of raw) {
      if (!f.label || isPiiLabel(f.label)) continue;
      const out: ScrapedField = {
        id: f.id,
        label: normalizeLabelDisplay(f.label),
        type: f.type,
        required: f.required,
      };
      if (f.maxLen !== null) out.maxLen = f.maxLen;
      fields.push(out);
    }
    return fields;
  } finally {
    await context.close();
  }
}

function normalizeLabelDisplay(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
}

export async function scrapeGreenhouse(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapeResult> {
  const handle = parseGreenhouseHandle(applyUrl);
  if (!handle) {
    return { ats: "greenhouse", source: "api", fields: [], error: "could not parse Greenhouse URL" };
  }
  const apiFields = await fetchGreenhouseApi(handle);
  if (apiFields !== null) {
    return { ats: "greenhouse", source: "api", fields: apiFields };
  }
  const domFields = await scrapeGreenhouseDom(applyUrl, browser);
  return { ats: "greenhouse", source: "dom", fields: domFields };
}
