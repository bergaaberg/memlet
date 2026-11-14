# memlet

A tiny memory for assistants. A few hundred one-sentence facts per scope, kept in any
SQLite (D1, a Durable Object's own, node:sqlite), pasted whole into the prompt, and
changed after each conversation by a cheap model whose every proposal is checked.

Built for [Dovre](https://dovre.dev) and lightweight SQLite/Cloudflare Workers assistants.

## The idea

- **Small enough to read whole.** A full scope of 100 memories goes into the prompt behind
  a cache breakpoint, so there is no retrieval to miss and no embedding pipeline. The
  block is paid for on every turn, so it carries only the sentences, grouped under
  Preferences, Decisions and Facts: no ids, no per-line labels. On the eval's 100-memory
  scope that is about 1,500 tokens, half of what 0.1 sent. `recall()` fills a token
  budget (default 3,000), newest first, for the day a scope outgrows that; full-text
  search, then embeddings, would slot in behind it without callers changing.
- **The write side is the product.** After a conversation, `reflect()` hands a cheap
  model the current memories and the conversation, and asks for changes: add, update,
  delete. Change beats add; an empty answer is the usual one. memlet builds the prompt
  and checks every answer; the app makes the call with its own model client.
- **Reflection is cheap.** The rules never change, and the memories change only when a
  memory does, so both sit in front of the conversation where they cache. Memories are
  numbered rather than shown with ids. Pass `seen` and only new turns are sent. Thanks
  and greetings never reach the model.
- **Checked, not trusted.** Every proposal goes through the same checks as a direct
  write: one sentence under the length cap, no secrets (keys, long tokens, passwords,
  fødselsnummer, card numbers), no duplicates, never past the cap, at most 3 adds per
  conversation, update and delete only on ids in the same scope.
- **The user's words only.** Pass user and assistant turns, never tool results: mail,
  web pages and rows can say "remember this" too.
- **A scope is a wall.** Every row belongs to one scope (the operator, a publication, a
  traveller). One scope can't read, change or delete another's. `clear()` empties one,
  for offboarding.
- **Every change has a history.** Each write records what the memory said before and
  after, and which call made it. `undo()` reverses a whole reflection, but only where
  nothing has changed since, and through the same checks.
- **Recall never writes.** No "last used" stamp: that would be a row write per memory per
  turn, and writes are what bills.
- **People can see it.** Each app should show the list with a delete button. Memory
  nobody can see feels like being watched; memory they can prune earns trust.

## Use

```ts
import { type Complete, fromD1, memlet, reflect, toPrompt } from "memlet";

const mem = memlet(fromD1(env.DB), { scope: "operator" });

// Each turn: the memories go after the stable system prompt, behind their own cache breakpoint.
const { memories, omitted } = await mem.recall();
const system = [{ type: "text", text: BASE, cache_control: { type: "ephemeral" } },
                { type: "text", text: toPrompt(memories, { omitted }), cache_control: { type: "ephemeral" } }];

// After the reply has gone out: propose and apply changes. Cache the rules and the memories.
const cached = { type: "ephemeral" } as const;
const complete: Complete = ({ system, parts }) =>
  haiku({
    system: [{ type: "text", text: system, cache_control: cached }],
    content: [{ type: "text", text: parts!.memories, cache_control: cached },
              { type: "text", text: parts!.conversation }],
  });
ctx.waitUntil(
  reflect(mem, turns, complete, { subject: "the operator", source: chatId, seen: chat.seen })
    .then((result) => saveSeen(chatId, result.seen)),
);
```

`turns` is `{ role: "user" | "assistant", text }[]`. `reflect` returns what it applied,
what it refused and why, how many malformed proposals it dropped, the `batch` its changes
are filed under, and `seen`. Log it. A client that sends one string can use `user`
instead of `parts`.

`seen` is how many of `turns` were already reflected on; keep it with the chat and pass it
back, and only the turns after it are sent (with the one before, as context). When the new
user turns are only thanks and greetings, no call is made and `skipped` says why;
`gate: false` turns that off.

Each change is in the history: `mem.history()` lists them newest first, `mem.undo()`
reverses the latest batch, `mem.undo(result.batch)` a given one. A change is reversed
only if the memory is still as the batch left it, and a restore is checked like any
write. Undoing the undo redoes. `forget(id)` keeps the history so a delete can be undone;
`forget(id, { purge: true })` and `clear()` keep no trace. `historyMax` (default 1000
events per scope) prunes the rest.

The schema: run `migrate(sql)` where there's no migrations folder (a Durable Object,
tests), or paste `SCHEMA_SQL` into a migration where there is (D1). Every statement is
`IF NOT EXISTS`, so coming from 0.1 you paste it again into a new migration; it adds the
`memlet_events` table and changes nothing that exists. Without it, writes fail.

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
  history() { return this.mem.history(); }
  undo(batch?: string) { return this.mem.undo(batch); }
  wipe() { return this.ctx.storage.deleteAll(); }
}
```

Keep the model call out of the object. An awake object bills wall-clock time, so a
3-second Haiku call inside it costs 60 times a plain write. The Worker reads the list,
builds the prompt (`reflectPrompt`), calls the model, parses with the prompt's numbering
(`parseOps(answer, prompt.refs)`) and sends the ops to `apply`.

## Install

A git dependency, pinned by tag. `dist/` is committed, because a git dependency runs no
build and Node won't strip types inside `node_modules`.

Write the pin by hand in `package.json`, then install:

```json
"memlet": "git+https://github.com/bergaaberg/memlet.git#v0.2.0"
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
pnpm eval       # tokens and memory quality against 0.1.1; --write saves eval/RESULTS.md
```

The eval compares the current prompts with 0.1.1's, frozen in `eval/v01.ts`: tokens of
the per-turn block, what the default recall shows, the input of three reflections over one
chat, and eleven scenarios run through the real write path (a preference is added, a change
updates rather than adds, a secret is refused, pasted text doesn't count, and so on). The
scripted run gives ideal answers and runs in the tests; `pnpm eval --live` asks a real model
and bills. Tokens come from the count_tokens endpoint when `ANTHROPIC_API_KEY` is set;
otherwise from an o200k tokenizer, which is not Claude's and reads low, so trust its ratios
only. Commit `eval/RESULTS.md` with any change to a prompt.

The pre-commit hook runs `pnpm check`. Release: bump `version`, commit, tag `vX.Y.Z`, push
the tag, then bump the pin in each app.
