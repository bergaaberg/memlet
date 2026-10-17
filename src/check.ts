/**
 * What may become a memory. A memory is one plain sentence that will be pasted into a
 * prompt on every later turn, so the rules lean strict: short, no secrets, no repeats.
 * The model that proposes memories is told the same rules (reflect.ts); this is the
 * part that doesn't depend on it listening.
 */

export const KINDS = ["fact", "preference", "decision"] as const;
export type Kind = (typeof KINDS)[number];

export type Refusal = "empty" | "too_long" | "secret" | "duplicate" | "bad_kind";

/** Whitespace collapsed, ends trimmed: what gets stored and compared. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Provider keys: sk-…, sk_live_…, ghp_…, xoxb-…, AKIA…
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9]{12,}/,
  /\b(?:ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Any long unbroken token: a key, a hash, a session id. Nothing worth remembering looks like this.
  /[A-Za-z0-9_+/=-]{32,}/,
  /\b(?:password|passord|passwd|pwd)\s*[:=]/i,
  // A Norwegian national ID (fødselsnummer), and card numbers.
  /\b\d{6}\s?\d{5}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
];

export function looksSecret(text: string): boolean {
  return SECRETS.some((re) => re.test(text));
}

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Why `text` can't be stored, or null if it can. `existing` is the scope's other memories. */
export function refuse(text: string, maxChars: number, existing: readonly string[]): Refusal | null {
  const clean = normalize(text);
  if (!clean) return "empty";
  if (clean.length > maxChars) return "too_long";
  if (looksSecret(clean)) return "secret";
  const key = clean.toLowerCase();
  if (existing.some((other) => normalize(other).toLowerCase() === key)) return "duplicate";
  return null;
}
