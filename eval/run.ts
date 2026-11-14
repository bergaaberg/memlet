/**
 * memlet's eval: what memory costs in tokens, and whether it keeps the right things.
 *
 *   pnpm eval            token costs and the scripted quality run, printed
 *   pnpm eval --write    the same, saved to eval/RESULTS.md (commit it with the change)
 *   pnpm eval --live     also asks a real model (MEMLET_EVAL_MODEL, default Haiku), billed
 *
 * Every number compares 0.1.1's prompts (eval/v01.ts, frozen) with the current src.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { type Complete, estimateTokens, fromNodeSqlite, memlet, migrate, reflect, toPrompt } from "../src/index.ts";
import { counter, hasCredentials, MODEL } from "./count.ts";
import { MEMORIES } from "./fixtures.ts";
import { type Outcome, runScenario, scripted } from "./quality.ts";
import { SCENARIOS, SESSION } from "./scenarios.ts";
import * as v01 from "./v01.ts";

const args = new Set(process.argv.slice(2));
const tokens = counter();
const out: string[] = [];
const say = (line = "") => out.push(line);
const pct = (from: number, to: number) => (from ? `${Math.round(((from - to) / from) * 100)}%` : "–");

say("# memlet eval");
say();
say(`Tokens counted with ${tokens.name}.${tokens.exact ? "" : " Compare rows with each other, not with a bill."}`);
say("Baseline is memlet 0.1.1's prompts, frozen in eval/v01.ts. Fixtures: eval/fixtures.ts (100 memories), eval/scenarios.ts.");

// 1. The block the assistant reads on every turn.
say();
say("## Per-turn memory block");
say();
say("| memories | 0.1.1 tokens | now tokens | saved per turn | saved |");
say("|---:|---:|---:|---:|---:|");
for (const n of [10, 50, 100]) {
  const rows = MEMORIES.slice(0, n);
  const before = await tokens.count(v01.toPrompt(rows));
  const after = await tokens.count(toPrompt(rows));
  say(`| ${n} | ${before} | ${after} | ${before - after} | ${pct(before, after)} |`);
}

// 2. What the default recall budget lets in from a full scope.
const sql = fromNodeSqlite(new DatabaseSync(":memory:"));
await migrate(sql);
const full = memlet(sql, { scope: "operator", now: (() => {
  let i = 0;
  return () => new Date(Date.UTC(2026, 10, 1) + i++ * 1000);
})() });
for (const m of [...MEMORIES].reverse()) await full.add(m.text, { kind: m.kind });
const oldFit = v01.recall(await full.list());
const nowFit = await full.recall();
say();
say("## Default recall on a full scope (100 memories)");
say();
say("| | memories shown | block tokens |");
say("|---|---:|---:|");
say(`| 0.1.1 (8000 chars) | ${oldFit.length} | ${await tokens.count(v01.toPrompt(oldFit, { omitted: 100 - oldFit.length }))} |`);
say(`| now | ${nowFit.memories.length} | ${await tokens.count(toPrompt(nowFit.memories, { omitted: nowFit.omitted }))} |`);

// How far recall's estimate is from the counter, on the full block.
{
  const block = toPrompt(nowFit.memories, { omitted: nowFit.omitted });
  const counted = await tokens.count(block);
  const estimated = estimateTokens(block);
  say();
  say(`recall's estimate for that block is ${estimated} tokens against ${counted} counted (${estimated >= counted ? "+" : ""}${Math.round(((estimated - counted) / counted) * 100)}%); a budget errs toward fitting when this is positive.`);
}

// 3. Reflection over one long chat, reflected on three times.
say();
say("## Reflection: one 12-turn chat, reflected after turns 4, 8 and 12, 100 memories");
say();
let oldTotal = 0;
let nowTotal = 0;
let nowCalls = 0;
const rows = await full.list();
const lines: string[] = [];
for (const k of SESSION.reflectAfter) {
  const turns = SESSION.turns.slice(0, k);
  const old = v01.reflectPrompt(full, rows, turns, { subject: "the operator" });
  const oldTokens = (await tokens.count(old.system)) + (await tokens.count(old.user));
  oldTotal += oldTokens;
  let nowTokens = 0;
  const record: Complete = async ({ system, user }) => {
    nowCalls++;
    nowTokens = (await tokens.count(system)) + (await tokens.count(user));
    return '{"ops": []}';
  };
  await reflect(full, turns, record, { subject: "the operator" });
  nowTotal += nowTokens;
  lines.push(`| after turn ${k} | ${oldTokens} | ${nowTokens || "skipped"} |`);
}
say("| | 0.1.1 input tokens | now input tokens |");
say("|---|---:|---:|");
for (const l of lines) say(l);
say(`| **total** | **${oldTotal}** | **${nowTotal}** (${nowCalls} calls, ${pct(oldTotal, nowTotal)} saved) |`);

// 4. Quality.
async function suite(label: string, make: (s: (typeof SCENARIOS)[number]) => Complete) {
  const results: Outcome[] = [];
  for (const s of SCENARIOS) results.push(await runScenario(s, make(s)));
  const passed = results.filter((r) => r.pass).length;
  const calls = results.reduce((n, r) => n + r.calls, 0);
  say();
  say(`## Quality: ${label}`);
  say();
  say(`${passed} of ${results.length} scenarios pass; ${calls} model calls for ${results.length} conversations.`);
  say();
  say("| scenario | result | calls | applied | refused |");
  say("|---|---|---:|---:|---|");
  for (const r of results) {
    say(`| ${r.name} | ${r.pass ? "pass" : `FAIL: ${r.failures.join("; ")}`} | ${r.calls} | ${r.applied} | ${r.rejected.join(", ") || "–"} |`);
  }
}

await suite("scripted (ideal answers, checks the pipeline)", scripted);

if (args.has("--live")) {
  if (!hasCredentials()) {
    say();
    say("_--live skipped: no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN._");
  } else {
    const client = new Anthropic();
    const usage = { input: 0, cached: 0, output: 0 };
    const live: Complete = async ({ system, user }) => {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: "low" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      });
      usage.input += res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0);
      usage.cached += res.usage.cache_read_input_tokens ?? 0;
      usage.output += res.usage.output_tokens;
      if (res.stop_reason === "refusal") return "";
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    };
    await suite(`live, ${MODEL}`, () => live);
    say();
    say(`Usage: ${usage.input} input, ${usage.cached} cache-read, ${usage.output} output tokens.`);
  }
}

const report = `${out.join("\n")}\n`;
process.stdout.write(report);
if (args.has("--write")) writeFileSync(new URL("./RESULTS.md", import.meta.url), report);
