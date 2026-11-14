# memlet

README.md has the idea and the API; this file holds the rules.

- Runs in Workers, Durable Objects and Node alike. Never import `node:*`, `cloudflare:*`
  or a model SDK from `src/`; adapters are typed by shape (`src/sql.ts`).
- No model calls in memlet. The app passes a `Complete` function.
- Every guard on a write (`src/check.ts`, `apply()`) has a test, including the case that
  should be refused. A new kind of secret is a new regex plus a test line.
- `dist/` is committed and must match `src/`: `pnpm check` before every commit (the hook
  runs it). Never `--no-verify`.
- The table schema is additive only: apps paste `SCHEMA_SQL` into migrations they never
  edit. A new column needs a default and a note in the release.
- A change to what memlet sends a model (`src/prompt.ts`, `src/reflect.ts`) is measured:
  `pnpm eval --write`, and commit `eval/RESULTS.md` with it. Never edit `eval/v01.ts`.
- Keep it small. Retrieval beyond "everything that fits" (FTS, embeddings) waits until a
  real scope outgrows the budget.
