/**
 * What may become a memory. A memory is one plain sentence that will be pasted into a
 * prompt on every later turn, so the rules lean strict: short, no secrets, no repeats.
 * The model that proposes memories is told the same rules (reflect.ts); this is the
 * part that doesn't depend on it listening.
 */
export declare const KINDS: readonly ["fact", "preference", "decision"];
export type Kind = (typeof KINDS)[number];
export type Refusal = "empty" | "too_long" | "secret" | "duplicate" | "bad_kind";
/** Whitespace collapsed, ends trimmed: what gets stored and compared. */
export declare function normalize(text: string): string;
export declare function looksSecret(text: string): boolean;
export declare function isKind(value: unknown): value is Kind;
/** Why `text` can't be stored, or null if it can. `existing` is the scope's other memories. */
export declare function refuse(text: string, maxChars: number, existing: readonly string[]): Refusal | null;
