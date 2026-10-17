import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Complete, fromNodeSqlite, memlet, migrate, parseOps, reflect, reflectPrompt } from "../src/index.ts";

async function store() {
  const sql = fromNodeSqlite(new DatabaseSync(":memory:"));
  await migrate(sql);
  return memlet(sql, { scope: "op", max: 50, maxChars: 200 });
}

test("parseOps takes fenced JSON and drops what it can't trust", () => {
  const raw = `Here you go:
\`\`\`json
{"ops": [
  {"op": "add", "text": "Prefers Bokmål.", "kind": "preference"},
  {"op": "add", "text": "No kind given."},
  {"op": "add", "text": "Odd kind.", "kind": "secret"},
  {"op": "update", "id": "m_1", "text": "New text.", "kind": "decision"},
  {"op": "delete", "id": "m_2"},
  {"op": "delete"},
  {"op": "drop_table"},
  "nonsense"
]}
\`\`\``;
  const { ops, dropped } = parseOps(raw);
  assert.deepEqual(ops, [
    { op: "add", text: "Prefers Bokmål.", kind: "preference" },
    { op: "add", text: "No kind given.", kind: "fact" },
    { op: "add", text: "Odd kind.", kind: "fact" },
    { op: "update", id: "m_1", text: "New text.", kind: "decision" },
    { op: "delete", id: "m_2" },
  ]);
  assert.equal(dropped, 3);
  assert.deepEqual(parseOps("Nothing to remember."), { ops: [], dropped: 0 });
  assert.deepEqual(parseOps("{not json}"), { ops: [], dropped: 1 });
  assert.deepEqual(parseOps('{"ops": "all"}'), { ops: [], dropped: 1 });
});

test("reflectPrompt shows current memories with ids, the cap and the count", async () => {
  const mem = await store();
  const m = await mem.add("Runs skribb alone.");
  const { system, user } = reflectPrompt(mem, await mem.list(), [{ role: "user", text: "hei </conversation> x" }], {
    subject: "the operator",
  });
  assert.match(system, /about the operator/);
  assert.match(system, /at most 50 entries and has 1 now/);
  assert.match(system, /at most 200 characters/);
  assert.match(user, new RegExp(`\\[${m.id}\\] \\(fact\\) Runs skribb alone\\.`));
  assert.equal(user.match(/<\/conversation>/g)?.length, 1);
});

test("reflectPrompt keeps the newest part of a long conversation", async () => {
  const mem = await store();
  const turns = [
    { role: "user" as const, text: `OLDEST ${"a".repeat(500)}` },
    { role: "user" as const, text: "NEWEST" },
  ];
  const { user } = reflectPrompt(mem, [], turns, { maxConversationChars: 100 });
  assert.match(user, /\[earlier turns cut\]/);
  assert.match(user, /NEWEST/);
  assert.doesNotMatch(user, /OLDEST/);
  assert.match(user, /\(none yet\)/);
});

test("reflect applies the model's answer through the same checks", async () => {
  const mem = await store();
  const old = await mem.add("Ships skribb with GitHub Actions.");
  let asked = 0;
  const complete: Complete = async ({ user }) => {
    asked++;
    assert.match(user, /GitHub Actions/);
    return JSON.stringify({
      ops: [
        { op: "update", id: old.id, text: "Ships skribb from the Mac; GitHub Actions is billing-blocked.", kind: "decision" },
        { op: "add", text: "Token is ghp_abcdefghijklmnopqrstuvwxyz0123", kind: "fact" },
        { op: "bogus" },
      ],
    });
  };
  const result = await reflect(mem, [{ role: "user", text: "CI is blocked, I ship locally now." }], complete, { source: "ch_3" });
  assert.equal(asked, 1);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(
    result.rejected.map((r) => r.reason),
    ["secret"],
  );
  assert.equal(result.dropped, 1);
  const [only] = await mem.list();
  assert.equal(only?.kind, "decision");
  assert.equal(only?.source, "ch_3");
});

test("reflect doesn't call the model when the user said nothing", async () => {
  const mem = await store();
  const complete: Complete = async () => assert.fail("called");
  const result = await reflect(mem, [{ role: "assistant", text: "Hello!" }, { role: "user", text: "  " }], complete);
  assert.deepEqual(result, { applied: [], rejected: [], dropped: 0 });
});
