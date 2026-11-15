/**
 * Runs the scenarios through the real write path (reflect → parse → apply with every
 * check) against an in-memory SQLite, and scores the end state.
 */
import { DatabaseSync } from "node:sqlite";
import { type Complete, fromNodeSqlite, memlet, migrate, reflect } from "../src/index.ts";
import type { IdealOp, Scenario } from "./scenarios.ts";

export type Outcome = {
  name: string;
  pass: boolean;
  failures: string[];
  /** Model calls made; 0 when reflect decided there was nothing to ask about. */
  calls: number;
  applied: number;
  rejected: string[];
  memories: string[];
};

export async function runScenario(s: Scenario, complete: Complete): Promise<Outcome> {
  const sql = fromNodeSqlite(new DatabaseSync(":memory:"));
  await migrate(sql);
  let tick = 0;
  const mem = memlet(sql, { scope: "eval", now: () => new Date(Date.UTC(2026, 10, 1, 12, 0, tick++)) });
  for (const [kind, text] of s.memories) await mem.add(text, { kind });

  let calls = 0;
  const counted: Complete = (prompt) => {
    calls++;
    return complete(prompt);
  };
  const result = await reflect(mem, s.turns, counted, { subject: "the operator", source: "eval" });
  const memories = (await mem.list()).map((m) => m.text);

  const failures: string[] = [];
  for (const re of s.has ?? []) if (!memories.some((t) => re.test(t))) failures.push(`missing ${re}`);
  for (const re of s.hasNot ?? []) {
    const hit = memories.find((t) => re.test(t));
    if (hit) failures.push(`kept ${re}: "${hit}"`);
  }
  if (s.count !== undefined && memories.length !== s.count) failures.push(`${memories.length} memories, wanted ${s.count}`);
  return {
    name: s.name,
    pass: failures.length === 0,
    failures,
    calls,
    applied: result.applied.length,
    rejected: result.rejected.map((r) => r.reason),
    memories,
  };
}

/**
 * A stand-in model that gives each scenario's ideal answer. It finds the memory an op
 * targets in the prompt it was sent, so it keeps working however the prompt names
 * memories (an id in brackets, or a number).
 */
export function scripted(s: Scenario): Complete {
  return async ({ user }) => {
    const lines = user.split("\n");
    const name = (target: RegExp) => {
      const line = lines.find((l) => target.test(l) && /^(?:- \[m_|\d+\.)/.test(l));
      if (!line) return { id: "m_missing" };
      const id = line.match(/\[(m_\w+)\]/)?.[1];
      if (id) return { id };
      return { ref: Number(line.match(/^(\d+)\./)?.[1]) };
    };
    const ops = s.ideal.map((op: IdealOp) => {
      if (op.op === "add") return op;
      const { target, ...rest } = op;
      return { ...rest, ...name(target) };
    });
    return JSON.stringify({ ops });
  };
}
