# Changelog

## 0.2.0

Token use and history. Measured with `pnpm eval` (eval/RESULTS.md); token counts there
are from an o200k proxy, so read them as ratios.

**Migration, D1:** paste `SCHEMA_SQL` again into a new migration. Every statement is
`IF NOT EXISTS`; it adds the `memlet_events` table and two indexes and changes nothing
that exists. A Durable Object's `migrate(sql)` does this by itself. Without the table,
writes fail.

**Changed**

- `toPrompt` drops ids and per-line kinds and groups memories under Preferences,
  Decisions and Facts. About 50% fewer tokens a turn: 2,979 to 1,496 at 100 memories.
  `memoryLines` still renders ids, for tools and UIs.
- `recall()` budgets in estimated tokens: `budgetTokens`, default 3,000, which fits a
  full 100-memory scope. 0.1's default (8,000 characters) showed 87. `budgetChars` still
  works as before.
- `reflectPrompt` numbers memories instead of showing ids, and the model answers with
  `ref`. If you call `reflectPrompt` and `parseOps` yourself (the Durable Object split),
  pass the prompt's `refs`: `parseOps(answer, prompt.refs)`. Without them, a number
  becomes an id no memory has and `apply()` refuses it as `unknown_id`; nothing wrong is
  written. Answers with 0.1-style `id`s still parse.
- The reflect rules no longer include the memory count (it moved next to the memories),
  so they are the same on every call and cache.
- `ApplyResult` has `batch` (null when nothing changed). `reflect` returns `seen`, and
  `skipped` when it made no call.

**Added**

- `reflectPrompt(...).parts` and `Complete`'s `parts`: the memories and the conversation
  apart, for a second cache breakpoint.
- `reflect({ seen })`: only turns after `seen` are sent, with the one before as context.
- A skip gate: no model call when the new user turns are only thanks and greetings.
  `gate: false` turns it off. `isSmallTalk` is exported.
- `memlet_events`: every write records before and after, kind, source and a batch id.
  `history()`, `undo(batch?)`, `forget(id, { purge: true })`, and the `historyMax` option
  (default 1,000 events per scope; 0 keeps none). `clear()` also clears the history.
- `estimateTokens`, the estimate `recall` budgets with.
- `pnpm eval`: tokens and memory quality against 0.1.1.

**Fixed**

- Text in a conversation can no longer open or close `<memories>`, `<earlier>` or
  `<conversation>` in the reflect prompt; 0.1 only sealed `</conversation>`.
