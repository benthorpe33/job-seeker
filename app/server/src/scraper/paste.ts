import { parse, type HTMLElement, type Node } from "node-html-parser";

import type { PasteRequest, ScrapedField, ScrapeResult } from "@job-seeker/shared";

const PII_LABEL_REGEX =
  /^(first name|last name|full name|name|email( address)?|phone( number)?|mobile|linkedin( url| profile)?|github( url)?|website|portfolio|resume|cv|cover letter)\s*\*?\s*$/i;

const SKIP_NAME_REGEX =
  /^(email|phone|firstName|lastName|fullName|name|website|linkedin|github|resume|cv|coverLetter)$/i;

const MAX_LABEL_LEN = 1000;
const MAX_FIELDS = 50;
const MIN_LABEL_LEN = 4;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncateLabel(s: string): string {
  if (s.length <= MAX_LABEL_LEN) return s;
  return s.slice(0, MAX_LABEL_LEN) + "…";
}

function isHTMLElement(node: Node | undefined | null): node is HTMLElement {
  return !!node && (node as HTMLElement).nodeType === 1;
}

function textOf(el: HTMLElement | null): string {
  if (!el) return "";
  return collapseWhitespace(el.text ?? "");
}

function getAttr(el: HTMLElement, name: string): string | null {
  const v = el.getAttribute(name);
  return typeof v === "string" ? v : null;
}

function findAncestorLabel(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentNode as HTMLElement | null;
  while (isHTMLElement(cur)) {
    if (cur.tagName?.toLowerCase() === "label") return cur;
    cur = cur.parentNode as HTMLElement | null;
  }
  return null;
}

function findPrecedingLabel(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    let prev: Node | null = (cur as unknown as { previousElementSibling?: HTMLElement | null })
      .previousElementSibling ?? null;
    while (prev) {
      if (isHTMLElement(prev) && prev.tagName?.toLowerCase() === "label") {
        return prev;
      }
      prev = (prev as unknown as { previousElementSibling?: Node | null })
        .previousElementSibling ?? null;
    }
    cur = cur.parentNode as HTMLElement | null;
  }
  return null;
}

function resolveLabelByForId(root: HTMLElement, id: string): HTMLElement | null {
  if (!id) return null;
  const labels = root.querySelectorAll("label");
  for (const lab of labels) {
    if (getAttr(lab, "for") === id) return lab;
  }
  return null;
}

function resolveLabelByLabelledBy(
  root: HTMLElement,
  labelledByIds: string,
): string {
  const ids = labelledByIds.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const id of ids) {
    const node = root.querySelector(`#${escapeCssId(id)}`);
    if (node) parts.push(node.text ?? "");
  }
  return collapseWhitespace(parts.join(" "));
}

function escapeCssId(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function resolveLabel(root: HTMLElement, input: HTMLElement): string {
  const id = getAttr(input, "id") ?? "";
  if (id) {
    const byFor = resolveLabelByForId(root, id);
    if (byFor) {
      const t = textOf(byFor);
      if (t) return t;
    }
  }
  const ancestor = findAncestorLabel(input);
  if (ancestor) {
    const t = textOf(ancestor);
    if (t) return t;
  }
  const preceding = findPrecedingLabel(input);
  if (preceding) {
    const t = textOf(preceding);
    if (t) return t;
  }
  const aria = getAttr(input, "aria-label");
  if (aria) {
    const t = collapseWhitespace(aria);
    if (t) return t;
  }
  const labelledBy = getAttr(input, "aria-labelledby");
  if (labelledBy) {
    const t = resolveLabelByLabelledBy(root, labelledBy);
    if (t) return t;
  }
  return "";
}

function stripNoise(root: HTMLElement): void {
  const tags = ["script", "style", "noscript"];
  for (const tag of tags) {
    for (const el of root.querySelectorAll(tag)) {
      el.remove();
    }
  }
}

function extractFromHtml(html: string): ScrapedField[] {
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
  });
  stripNoise(root);

  const inputs = [
    ...root.querySelectorAll("textarea"),
    ...root.querySelectorAll('input[type="text"]'),
    ...root.querySelectorAll("input:not([type])"),
  ];

  const fields: ScrapedField[] = [];
  let idx = 0;
  for (const input of inputs) {
    const tag = input.tagName?.toLowerCase();
    const type = (getAttr(input, "type") ?? "").toLowerCase();
    if (type === "hidden") continue;
    const name = getAttr(input, "name") ?? "";
    if (name && SKIP_NAME_REGEX.test(name)) continue;

    const rawLabel = resolveLabel(root, input);
    const collapsed = collapseWhitespace(rawLabel);
    if (collapsed.length < MIN_LABEL_LEN) continue;
    if (PII_LABEL_REGEX.test(collapsed)) continue;

    const fieldType: "text" | "textarea" = tag === "textarea" ? "textarea" : "text";
    const required =
      input.hasAttribute("required") ||
      getAttr(input, "aria-required") === "true";
    const maxLenStr = getAttr(input, "maxlength");
    const maxLen = maxLenStr ? Number.parseInt(maxLenStr, 10) : NaN;

    const field: ScrapedField = {
      id: `h${idx}`,
      label: truncateLabel(collapsed),
      type: fieldType,
      required,
    };
    if (Number.isFinite(maxLen) && maxLen > 0) {
      field.maxLen = maxLen;
    }
    fields.push(field);
    idx++;
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

function extractFromPlaintext(text: string): ScrapedField[] {
  const blocks = text.split(/\n\s*\n/);
  const fields: ScrapedField[] = [];
  let idx = 0;
  for (const rawBlock of blocks) {
    let block = rawBlock.trim();
    if (!block) continue;
    block = block.replace(/^[-*•]\s+/, "");
    block = block.replace(/^\d+[.)]\s+/, "");
    block = collapseWhitespace(block);
    if (block.length < MIN_LABEL_LEN) continue;
    if (PII_LABEL_REGEX.test(block)) continue;
    fields.push({
      id: `p${idx}`,
      label: truncateLabel(block),
      type: "textarea",
      required: false,
    });
    idx++;
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

export type ExtractInput = PasteRequest;

export function extractFromPaste(input: ExtractInput): ScrapeResult {
  const html = typeof input.html === "string" ? input.html : "";
  const plain = typeof input.plainText === "string" ? input.plainText : "";
  const hasHtml = html.trim().length > 0;
  const hasPlain = plain.trim().length > 0;

  const fields = hasHtml
    ? extractFromHtml(html)
    : hasPlain
      ? extractFromPlaintext(plain)
      : [];

  return {
    ats: "paste",
    source: "paste",
    fields,
  };
}
