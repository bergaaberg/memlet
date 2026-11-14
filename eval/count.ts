/**
 * Token counting for the eval. With Anthropic credentials in the environment
 * (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN) it asks the count_tokens endpoint, which is
 * exact for the model named in MEMLET_EVAL_MODEL. Without them it falls back to the
 * o200k BPE (gpt-tokenizer): not Claude's tokenizer, and it reads low on Claude by roughly
 * 15 to 20 percent, so trust its ratios between two renders, not its absolute counts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { countTokens as o200k } from "gpt-tokenizer";

export type Counter = { name: string; exact: boolean; count(text: string): Promise<number> };

export const MODEL = process.env.MEMLET_EVAL_MODEL ?? "claude-haiku-5-5";

export const hasCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export function counter(): Counter {
  if (!hasCredentials()) {
    return { name: "o200k proxy (gpt-tokenizer), not Claude's tokenizer", exact: false, count: async (t) => o200k(t) };
  }
  const client = new Anthropic();
  const cache = new Map<string, number>();
  const raw = async (text: string) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const { input_tokens } = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: text }] });
    cache.set(text, input_tokens);
    return input_tokens;
  };
  let overhead: number | undefined;
  return {
    name: `count_tokens on ${MODEL}`,
    exact: true,
    async count(text) {
      // The endpoint counts a whole request; take off what an almost empty one costs.
      overhead ??= (await raw(".")) - 1;
      return text ? (await raw(text)) - overhead : 0;
    },
  };
}
