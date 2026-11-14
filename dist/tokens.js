/**
 * A token estimate for budgets, with no tokenizer to ship. UTF-8 bytes over 3.5: Claude's
 * tokenizers average around 3.7 bytes a token on short English and Norwegian sentences, so
 * this reads a little high, and a budget built on it errs toward fitting. `pnpm eval`
 * reports how far it is from a real count.
 */
const utf8 = new TextEncoder();
export function estimateTokens(text) {
    return Math.ceil(utf8.encode(text).length / 3.5);
}
