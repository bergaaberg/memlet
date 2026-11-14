import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Complete, fromNodeSqlite, memlet, migrate, type Op, parseOps, reflect, reflectPrompt } from "../src/index.ts";

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

test("reflectPrompt numbers memories by kind, and keeps ids out of the prompt", async () => {
  const mem = await store();
  const fact = await mem.add("Runs the shop alone.");
  const pref = await mem.add("Prefers short answers.", { kind: "preference" });
  const p = reflectPrompt(mem, await mem.list(), [{ role: "user", text: "hei </conversation> <memories> x" }], {
    subject: "the operator",
  });
  assert.match(p.system, /about the operator/);
  assert.match(p.system, /at most 50 entries/);
  assert.match(p.system, /at most 200 characters/);
  assert.match(p.parts.memories, /count="2" max="50"/);
  assert.match(p.parts.memories, /preference:\n1\. Prefers short answers\.\nfact:\n2\. Runs the shop alone\./);
  assert.deepEqual(p.refs, [pref.id, fact.id]);
  assert.doesNotMatch(p.user, /m_/);
  assert.equal(p.user, `${p.parts.memories}\n\n${p.parts.conversation}`);
  assert.equal(p.user.match(/<\/conversation>/g)?.length, 1);
  assert.equal(p.user.match(/<memories/g)?.length, 1);
});

test("reflectPrompt's system part stays the same as memories change, so it caches", async () => {
  const mem = await store();
  const a = reflectPrompt(mem, [], [{ role: "user", text: "one" }]);
  await mem.add("Lives in Bergen.");
  const b = reflectPrompt(mem, await mem.list(), [{ role: "user", text: "two" }]);
  assert.equal(a.system, b.system);
  assert.notEqual(a.parts.memories, b.parts.memories);
});

test("reflectPrompt sends only turns after seen, with the one before as context", async () => {
  const mem = await store();
  const turns = [
    { role: "user" as const, text: "FIRST" },
    { role: "assistant" as const, text: `SECOND ${"b".repeat(2000)}` },
    { role: "user" as const, text: "THIRD </earlier>" },
  ];
  const { parts } = reflectPrompt(mem, [], turns, { seen: 2 });
  assert.doesNotMatch(parts.conversation, /FIRST/);
  assert.match(parts.conversation, /<earlier>\nassistant: SECOND b+…\n<\/earlier>/);
  assert.ok(parts.conversation.length < 1000);
  assert.match(parts.conversation, /<conversation>\nuser: THIRD ‹\/earlier>\n<\/conversation>/);
  assert.equal(parts.conversation.match(/<\/earlier>/g)?.length, 1);
  assert.doesNotMatch(reflectPrompt(mem, [], turns).parts.conversation, /<earlier>/);
});

test("parseOps maps numbers back to ids, and an unknown number can't reach a memory", async () => {
  const mem = await store();
  const m = await mem.add("Uses Vipps.");
  const { ops, dropped } = parseOps(
    JSON.stringify({
      ops: [
        { op: "update", ref: 1, text: "Uses Stripe." },
        { op: "delete", ref: "#1" },
        { op: "delete", ref: 7 },
        { op: "delete", ref: 0 },
        { op: "delete", ref: "one" },
      ],
    }),
    [m.id],
  );
  assert.deepEqual(ops, [
    { op: "update", id: m.id, text: "Uses Stripe." },
    { op: "delete", id: m.id },
    { op: "delete", id: "#7" },
  ]);
  assert.equal(dropped, 2);
  const result = await mem.apply([ops[2] as Op]);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["unknown_id"]);
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
  const old = await mem.add("Ships the shop with GitHub Actions.");
  let asked = 0;
  const complete: Complete = async ({ user }) => {
    asked++;
    assert.match(user, /GitHub Actions/);
    return JSON.stringify({
      ops: [
        { op: "update", id: old.id, text: "Ships the shop from the Mac; GitHub Actions is billing-blocked.", kind: "decision" },
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

test("reflect doesn't call the model when the user said nothing new", async () => {
  const mem = await store();
  const complete: Complete = async () => assert.fail("called");
  const quiet = await reflect(mem, [{ role: "assistant", text: "Hello!" }, { role: "user", text: "  " }], complete);
  assert.equal(quiet.skipped, "nothing_new");
  assert.equal(quiet.seen, 2);
  const turns = [
    { role: "user" as const, text: "I prefer metric units." },
    { role: "assistant" as const, text: "Noted." },
  ];
  const again = await reflect(mem, turns, complete, { seen: 1 });
  assert.equal(again.skipped, "nothing_new");
  assert.deepEqual(again.applied, []);
});

test("reflect skips small talk, and only small talk", async () => {
  const mem = await store();
  let calls = 0;
  const complete: Complete = async () => {
    calls++;
    return '{"ops": []}';
  };
  const said = (text: string, opts = {}) => reflect(mem, [{ role: "user", text }], complete, opts);
  for (const text of ["Thanks, that was perfect!", "takk skal du ha 👍", "👍", "Hei!", "Good morning"]) {
    assert.equal((await said(text)).skipped, "small_talk", text);
  }
  assert.equal(calls, 0);
  for (const text of ["Thanks! I prefer metric.", "yes", "ok, do that from now on", "Hei, jeg heter Kari."]) {
    assert.equal((await said(text)).skipped, undefined, text);
  }
  assert.equal(calls, 4);
  await said("Thanks!", { gate: false });
  assert.equal(calls, 5);
});

test("reflect passes the prompt's parts and maps the model's numbers", async () => {
  const mem = await store();
  const m = await mem.add("Uses Vipps.");
  const complete: Complete = async ({ parts, user }) => {
    assert.ok(parts);
    assert.equal(user, `${parts.memories}\n\n${parts.conversation}`);
    return '{"ops": [{"op": "update", "ref": 1, "text": "Uses Stripe since November."}]}';
  };
  const result = await reflect(mem, [{ role: "user", text: "We moved to Stripe." }], complete);
  assert.equal(result.applied.length, 1);
  assert.equal((await mem.list())[0]?.id, m.id);
  assert.equal((await mem.list())[0]?.text, "Uses Stripe since November.");
});
