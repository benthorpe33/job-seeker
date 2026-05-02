export const PII_LABEL_BLOCKLIST: ReadonlySet<string> = new Set([
  "first name",
  "last name",
  "full name",
  "name",
  "preferred name",
  "preferred first name",
  "email",
  "email address",
  "phone",
  "phone number",
  "mobile",
  "mobile number",
  "linkedin",
  "linkedin url",
  "linkedin profile",
  "github",
  "github url",
  "github profile",
  "website",
  "personal website",
  "portfolio",
  "portfolio url",
  "resume",
  "resume/cv",
  "cv",
  "cover letter",
]);

export function normalizeLabel(raw: string): string {
  return raw
    .replace(/\*+\s*$/, "")
    .replace(/\(required\)/gi, "")
    .replace(/\(optional\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isPiiLabel(label: string): boolean {
  if (!label) return true;
  return PII_LABEL_BLOCKLIST.has(normalizeLabel(label));
}
