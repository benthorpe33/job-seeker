import { createHash } from "node:crypto";

import type { Browser } from "playwright";

import { isPiiLabel } from "../pii.js";
import type { ParsedHandle, ScrapeResult, ScrapedField } from "../types.js";

export function parseAshbyHandle(applyUrl: string): ParsedHandle | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (!host.endsWith("ashbyhq.com")) return null;

  // jobs.ashbyhq.com/{slug}/{id}/application?
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;
  const slug = segments[0]!;
  const jobId = segments[1]!;
  if (!slug || !jobId) return null;
  return { slug, jobId };
}

type AshbyJob = {
  id?: string;
  jobId?: string;
  applicationFormDefinition?: {
    sections?: Array<{
      fields?: Array<AshbyFormField>;
    }>;
  };
  applicationForm?: {
    sections?: Array<{ fields?: Array<AshbyFormField> }>;
  };
};

type AshbyFormField = {
  field?: {
    id?: string;
    title?: string;
    type?: string;
    isNullable?: boolean;
  };
  isRequired?: boolean;
  descriptionPlain?: string;
};

type AshbyBoardResponse = {
  jobs?: AshbyJob[];
};

function stableId(prefix: string, label: string): string {
  return `${prefix}-${createHash("sha1").update(label).digest("hex").slice(0, 10)}`;
}

function mapAshbyField(f: AshbyFormField, idx: number): ScrapedField | null {
  const inner = f.field;
  const label = (inner?.title ?? "").trim();
  if (!label) return null;
  const rawType = (inner?.type ?? "").toLowerCase();

  let type: "text" | "textarea";
  if (rawType === "longtext" || rawType === "long_text") {
    type = "textarea";
  } else if (rawType === "shorttext" || rawType === "string" || rawType === "text") {
    type = "text";
  } else {
    return null;
  }

  return {
    id: inner?.id ?? stableId(`ashby-${idx}`, label),
    label,
    type,
    required: f.isRequired === true || inner?.isNullable === false,
  };
}

export async function fetchAshbyApi(
  handle: ParsedHandle,
): Promise<ScrapedField[] | null> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
    handle.slug,
  )}?includeCompensation=false`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;

  let json: AshbyBoardResponse;
  try {
    json = (await res.json()) as AshbyBoardResponse;
  } catch {
    return null;
  }
  const jobs = json.jobs ?? [];
  // Ashby IDs in URLs are case-sensitive; preserve verbatim.
  const job = jobs.find((j) => j.id === handle.jobId || j.jobId === handle.jobId);
  if (!job) return null;

  const def = job.applicationFormDefinition ?? job.applicationForm;
  const sections = def?.sections ?? [];
  const fields: ScrapedField[] = [];
  let idx = 0;
  for (const section of sections) {
    for (const f of section.fields ?? []) {
      const mapped = mapAshbyField(f, idx++);
      if (!mapped) continue;
      if (isPiiLabel(mapped.label)) continue;
      fields.push(mapped);
    }
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

export async function scrapeAshbyDom(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapedField[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    const raw = await page.evaluate(() => {
      const root = document.querySelector(
        "form, [class*='_application_form'], [class*='application-form']",
      );
      const scope: Element = root ?? document.body;
      const out: DomField[] = [];
      const wrappers = scope.querySelectorAll<HTMLElement>("[data-testid='field-input']");
      wrappers.forEach((wrap, idx) => {
        const inputs = wrap.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "textarea, input[type='text']",
        );
        inputs.forEach((el, jdx) => {
          let labelText = "";
          // Look for a sibling/ancestor labelled element
          const ancestorLabel = wrap
            .closest("[class*='field']")
            ?.querySelector("[data-testid='field-label']");
          if (ancestorLabel) labelText = (ancestorLabel.textContent ?? "").trim();
          if (!labelText) {
            const labelInside = wrap.querySelector("[data-testid='field-label']");
            if (labelInside) labelText = (labelInside.textContent ?? "").trim();
          }
          if (!labelText) {
            // Walk up looking for an element that contains a label text node
            let parent: Element | null = wrap.parentElement;
            for (let depth = 0; parent && depth < 4 && !labelText; depth++) {
              const lab = parent.querySelector("label, [data-testid='field-label']");
              if (lab) labelText = (lab.textContent ?? "").trim();
              parent = parent.parentElement;
            }
          }
          const required =
            el.required ||
            el.getAttribute("aria-required") === "true" ||
            !!wrap.querySelector("[aria-label*='required' i]");
          const maxLenAttr = el.getAttribute("maxlength");
          const maxLen = maxLenAttr ? Number.parseInt(maxLenAttr, 10) : null;
          out.push({
            id: el.id || el.name || `ashby-dom-${idx}-${jdx}`,
            label: labelText,
            type: el.tagName.toLowerCase() === "textarea" ? "textarea" : "text",
            required,
            maxLen: Number.isFinite(maxLen) ? maxLen : null,
          });
        });
      });
      return out;
    });

    const fields: ScrapedField[] = [];
    for (const f of raw) {
      if (!f.label || isPiiLabel(f.label)) continue;
      const out: ScrapedField = {
        id: f.id,
        label: f.label.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim(),
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

export async function scrapeAshby(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapeResult> {
  const handle = parseAshbyHandle(applyUrl);
  if (!handle) {
    return { ats: "ashby", source: "api", fields: [], error: "could not parse Ashby URL" };
  }
  const apiFields = await fetchAshbyApi(handle);
  if (apiFields !== null) {
    return { ats: "ashby", source: "api", fields: apiFields };
  }
  const domFields = await scrapeAshbyDom(applyUrl, browser);
  return { ats: "ashby", source: "dom", fields: domFields };
}
