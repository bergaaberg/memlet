import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite, memlet, migrate, type Sql, type StoreOptions } from "../src/index.ts";

async function fresh(opts: Partial<StoreOptions> = {}) {
  const db = new DatabaseSync(":memory:");
  const sql = fromNodeSqlite(db);
  await migrate(sql);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 14, 12, 0, tick++));
  return { db, sql, mem: memlet(sql, { scope: "op", now, ...opts }), now };
}

const texts = async (mem: { list(): Promise<{ text: string }[]> }) => (await mem.list()).map((m) => m.text).sort();

test("every write is in the history, with before and after, one batch per call", async () => {
  const { mem } = await fresh();
  const a = await mem.add("Uses Vipps.", { kind: "decision", source: "ui" });
  const result = await mem.apply(
    [
      { op: "update", id: a.id, text: "Uses Stripe." },
      { op: "add", text: "Lives in Voss.", kind: "fact" },
    ],
    { source: "ch_1" },
  );
  assert.match(result.batch ?? "", /^b_/);
  const events = await mem.history();
  assert.deepEqual(
    events.map((e) => [e.op, e.prev_text, e.text, e.source]),
    [
      ["add", null, "Lives in Voss.", "ch_1"],
      ["update", "Uses Vipps.", "Uses Stripe.", "ch_1"],
      ["add", null, "Uses Vipps.", "ui"],
    ],
  );
  assert.equal(events[0]?.batch, result.batch);
  assert.equal(events[1]?.batch, result.batch);
  assert.notEqual(events[2]?.batch, result.batch);
  assert.deepEqual(
    (await mem.history({ memoryId: a.id })).map((e) => e.op),
    ["update", "add"],
  );
  assert.equal((await mem.history({ limit: 1 })).length, 1);
});

test("a call that changes nothing has no batch and leaves no history", async () => {
  const { mem } = await fresh();
  const result = await mem.apply([{ op: "delete", id: "m_nope" }, { op: "add", text: "key sk_live_abcdefghijklmnop", kind: "fact" }]);
  assert.equal(result.batch, null);
  assert.equal(await mem.forget("m_nope"), false);
  await assert.rejects(mem.add("   "));
  assert.deepEqual(await mem.history(), []);
});

test("undo reverses a whole batch, and undoing the undo redoes it", async () => {
  const { mem } = await fresh();
  const vipps = await mem.add("Uses Vipps.", { kind: "decision" });
  const dog = await mem.add("Has a dog named Birk.");
  const before = await texts(mem);
  const result = await mem.apply([
    { op: "update", id: vipps.id, text: "Uses Stripe.", kind: "decision" },
    { op: "delete", id: dog.id },
    { op: "add", text: "Lives in Voss.", kind: "fact" },
  ]);
  const after = await texts(mem);
  const undone = await mem.undo();
  assert.equal(undone.undone, result.batch);
  assert.equal(undone.reverted.length, 3);
  assert.deepEqual(undone.rejected, []);
  assert.deepEqual(await texts(mem), before);
  // The restored memory keeps its id, so anything pointing at it still does.
  assert.ok((await mem.list()).some((m) => m.id === dog.id));
  const redo = await mem.undo();
  assert.equal(redo.undone, undone.batch);
  assert.deepEqual(await texts(mem), after);
});

test("undo leaves alone what changed since, and says so", async () => {
  const { mem } = await fresh();
  const result = await mem.apply([{ op: "add", text: "Lives in Voss.", kind: "fact" }]);
  const [m] = await mem.list();
  await mem.update(m?.id ?? "", "Lives in Bergen.");
  const undone = await mem.undo(result.batch ?? "");
  assert.equal(undone.batch, null);
  assert.deepEqual(
    undone.rejected.map((r) => r.reason),
    ["changed_since"],
  );
  assert.deepEqual(await texts(mem), ["Lives in Bergen."]);
});

test("an event whose change never landed undoes nothing", async () => {
  const { mem, sql } = await fresh();
  await sql.all(
    "INSERT INTO memlet_events (scope, batch, memory_id, op, text, kind, at) VALUES ('op', 'b_ghost', 'm_ghost', 'add', 'Ghost.', 'fact', 'x')",
  );
  const undone = await mem.undo();
  assert.equal(undone.undone, "b_ghost");
  assert.deepEqual(
    undone.rejected.map((r) => r.reason),
    ["changed_since"],
  );
});

test("a restore goes through the checks: refused when full or a duplicate", async () => {
  const { mem } = await fresh({ max: 2 });
  const a = await mem.add("Likes tea.");
  await mem.add("Lives in Voss.");
  const gone = await mem.apply([{ op: "delete", id: a.id }]);
  await mem.add("Has a dog.");
  const full = await mem.undo(gone.batch ?? "");
  assert.deepEqual(
    full.rejected.map((r) => r.reason),
    ["full"],
  );
  const dog = (await mem.list()).find((m) => m.text === "Has a dog.");
  await mem.forget(dog?.id ?? "");
  await mem.add("likes   TEA.");
  const dup = await mem.undo(gone.batch ?? "");
  assert.deepEqual(
    dup.rejected.map((r) => r.reason),
    ["duplicate"],
  );
});

test("undo puts an update back only if the old text still passes the checks", async () => {
  const { mem } = await fresh();
  const a = await mem.add("Uses Vipps.");
  const changed = await mem.apply([{ op: "update", id: a.id, text: "Uses Stripe." }]);
  await mem.add("Uses Vipps.");
  const undone = await mem.undo(changed.batch ?? "");
  assert.deepEqual(
    undone.rejected.map((r) => r.reason),
    ["duplicate"],
  );
});

test("one scope can't read or undo another's history", async () => {
  const { sql } = await fresh();
  const mine = memlet(sql, { scope: "pub:1" });
  const theirs = memlet(sql, { scope: "pub:2" });
  const result = await mine.apply([{ op: "add", text: "Writes about fly fishing.", kind: "fact" }]);
  assert.deepEqual(await theirs.history(), []);
  const tried = await theirs.undo(result.batch ?? "");
  assert.equal(tried.undone, null);
  assert.equal((await theirs.undo()).undone, null);
  assert.equal((await mine.list()).length, 1);
});

test("forget keeps the history for undo; purge and clear keep no trace", async () => {
  const { mem } = await fresh();
  const a = await mem.add("Likes tea.");
  const b = await mem.add("Lives in Voss.");
  assert.equal(await mem.forget(a.id), true);
  assert.equal((await mem.history({ memoryId: a.id })).length, 2);
  assert.equal(await mem.forget(b.id, { purge: true }), true);
  assert.deepEqual(await mem.history({ memoryId: b.id }), []);
  assert.equal(await mem.forget(b.id, { purge: true }), false);
  await mem.add("Has a dog.");
  assert.equal(await mem.clear(), 1);
  assert.deepEqual(await mem.history(), []);
});

test("history is pruned to historyMax per scope, and 0 keeps none", async () => {
  const { sql } = await fresh();
  const small = memlet(sql, { scope: "s", historyMax: 3 });
  const other = memlet(sql, { scope: "t", historyMax: 3 });
  await other.add("Kept elsewhere.");
  for (let i = 0; i < 5; i++) await small.add(`Fact ${i}.`);
  assert.deepEqual(
    (await small.history()).map((e) => e.text),
    ["Fact 4.", "Fact 3.", "Fact 2."],
  );
  assert.equal((await other.history()).length, 1);
  const none = memlet(sql, { scope: "u", historyMax: 0 });
  const result = await none.apply([{ op: "add", text: "No trace.", kind: "fact" }]);
  assert.match(result.batch ?? "", /^b_/);
  assert.deepEqual(await none.history(), []);
  assert.equal((await none.undo()).undone, null);
});

test("when the write fails, its event goes too", async () => {
  const { sql: real } = await fresh();
  let fail = true;
  const flaky: Sql = {
    all(query, params) {
      if (fail && query.startsWith("INSERT INTO memlet_memories")) {
        fail = false;
        return Promise.reject(new Error("disk I/O error"));
      }
      return real.all(query, params);
    },
  };
  const mem = memlet(flaky, { scope: "op" });
  await assert.rejects(mem.add("Likes tea."), /disk I\/O/);
  assert.deepEqual(await mem.history(), []);
  await mem.add("Likes tea.");
  assert.equal((await mem.history()).length, 1);
});
