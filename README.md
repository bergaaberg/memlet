# memlet

A tiny memory for assistants. A few hundred one-sentence facts per scope, kept in any
SQLite (D1, a Durable Object's own, node:sqlite), pasted whole into the prompt, and
changed after each conversation by a cheap model whose every proposal is checked.

Built for [Dovre](https://dovre.dev) and lightweight SQLite/Cloudflare Workers assistants.

## The idea

- **Small enough to read whole.** 100 memories of ~150 characters is ~4k tokens. They all
  go into the prompt behind a cache breakpoint, so there is no retrieval to miss and no
  embedding pipeline. `recall()` trims to a budget, newest first, for the day a scope
  outgrows that; full-text search, then embeddings, would slot in behind it without
  callers changing.
- **The write side is the product.** After a conversation, `reflect()` hands a cheap
  model the current memories and the conversation, and asks for changes: add, update,
  delete. Change beats add; an empty answer is the usual one. memlet builds the prompt
  and checks every answer; the app makes the call with its own model client.
- **Checked, not trusted.** Every proposal goes through the same checks as a direct
  write: one sentence under the length cap, no secrets (keys, long tokens, passwords,
  fødselsnummer, card numbers), no duplicates, never past the cap, at most 3 adds per
  conversation, update and delete only on ids in the same scope.
- **The user's words only.** Pass user and assistant turns, never tool results: mail,
  web pages and rows can say "remember this" too.
- **A scope is a wall.** Every row belongs to one scope (the operator, a publication, a
  traveller). One scope can't read, change or delete another's. `clear()` empties one,
  for offboarding.
- **Recall never writes.** No "last used" stamp: that would be a row write per memory per
  turn, and writes are what bills.
- **People can see it.** Each app should show the list with a delete button. Memory
  nobody can see feels like being watched; memory they can prune earns trust.

## Use

```ts
import { fromD1, memlet, reflect, toPrompt } from "memlet";

const mem = memlet(fromD1(env.DB), { scope: "operator" });

// Each turn: the memories go after the stable system prompt, behind their own cache breakpoint.
const { memories, omitted } = await mem.recall();
const system = [{ type: "text", text: BASE, cache_control: { type: "ephemeral" } },
                { type: "text", text: toPrompt(memories, { omitted }), cache_control: { type: "ephemeral" } }];

// After the reply has gone out: propose and apply changes.
ctx.waitUntil(
  reflect(mem, turns, ({ system, user }) => haiku(system, user), { subject: "the operator", source: chatId }),
);
```

`turns` is `{ role: "user" | "assistant", text }[]`. `reflect` returns what it applied,
what it refused and why, and how many malformed proposals it dropped. Log it.

The schema: run `migrate(sql)` where there's no migrations folder (a Durable Object,
tests), or paste `SCHEMA_SQL` into a migration where there is (D1).

## One Durable Object per scope

When every user or project gets its own memory, give each scope its own
object. Isolation is then physical, deleting someone is `deleteAll()`, and the table never
grows past one scope's few hundred rows. Objects cost nothing while asleep; you pay for
requests, the time they're awake, and the bytes they store.

```ts
import { DurableObject } from "cloudflare:workers";
import { fromDurableObject, memlet, migrate, type Op, type Store } from "memlet";

export class Memory extends DurableObject {
  mem: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = fromDurableObject(ctx.storage.sql);
    this.mem = memlet(sql, { scope: "self" });
    ctx.blockConcurrencyWhile(() => migrate(sql));
  }
  list() { return this.mem.list(); }
  recall() { return this.mem.recall(); }
  apply(ops: Op[], source?: string) { return this.mem.apply(ops, { source }); }
  forget(id: string) { return this.mem.forget(id); }
  wipe() { return this.ctx.storage.deleteAll(); }
}
```

Keep the model call out of the object. An awake object bills wall-clock time, so a
3-second Haiku call inside it costs 60 times a plain write. The Worker builds the prompt
(`reflectPrompt`), calls the model, parses (`parseOps`) and sends the ops to `apply`.

## Install

A git dependency, pinned by tag. `dist/` is committed, because a git dependency runs no
build and Node won't strip types inside `node_modules`.

Write the pin by hand in `package.json`, then install:

```json
"memlet": "git+https://github.com/bergaaberg/memlet.git#v0.1.1"
```

- Use the `git+https` form so npm and pnpm resolve directly over HTTPS without requiring an SSH key.
- `pnpm add` drops the `#tag` from `package.json` (the lockfile still pins the commit).
  Put the tag back, or the next bump has nothing to move.

## License

MIT. See [LICENSE](./LICENSE).

## Work on it

```sh
pnpm install
pnpm check      # typecheck, test, build, and fail if dist doesn't match src
```

The pre-commit hook runs `pnpm check`. Release: bump `version`, commit, tag `vX.Y.Z`, push
the tag, then bump the pin in each app.
