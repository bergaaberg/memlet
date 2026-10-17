/**
 * The store: one table, rows keyed by scope. A scope is whoever the memories are about
 * (an operator, a publication, a traveller); one scope never sees or changes another's
 * rows. In a Durable Object per scope the column is constant and costs nothing; in a
 * shared D1 it is the wall.
 *
 * Recall never writes. A "last used" stamp would turn every assistant turn into a row
 * write per memory, and writes are the meter that bills.
 */
import { isKind, type Kind, normalize, type Refusal, refuse } from "./check.ts";
import type { Sql } from "./sql.ts";

export type Memory = {
  id: string;
  scope: string;
  text: string;
  kind: Kind;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export type Op =
  | { op: "add"; text: string; kind: Kind }
  | { op: "update"; id: string; text: string; kind?: Kind }
  | { op: "delete"; id: string };

export type Reason = Refusal | "full" | "unknown_id" | "too_many_adds";

export type ApplyResult = { applied: Op[]; rejected: { op: Op; reason: Reason }[] };

/** Each statement on its own, for engines that take one at a time (D1's prepare). */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memlet_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS memlet_memories_scope ON memlet_memories (scope, updated_at)",
];

/** The same, as one file's worth: paste into an app's migrations folder. */
export const SCHEMA_SQL = `${SCHEMA.join(";\n\n")};\n`;

/** For engines without a migrations folder (a Durable Object's constructor, tests). Idempotent. */
export async function migrate(sql: Sql): Promise<void> {
  for (const statement of SCHEMA) await sql.all(statement);
}

export const DEFAULTS = { max: 100, maxChars: 280, maxAddsPerApply: 3 } as const;

export type StoreOptions = {
  scope: string;
  /** Most memories one scope may hold. At the cap an add is refused until something is merged or deleted. */
  max?: number;
  /** Longest memory, in characters. */
  maxChars?: number;
  /** Most adds one apply() may make, so one chatty conversation can't fill the memory. */
  maxAddsPerApply?: number;
  now?: () => Date;
};

export class MemletError extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(`memlet: ${reason}`);
    this.reason = reason;
  }
}

export type Store = {
  readonly scope: string;
  readonly max: number;
  readonly maxChars: number;
  /** Newest change first. */
  list(): Promise<Memory[]>;
  add(text: string, opts?: { kind?: Kind; source?: string }): Promise<Memory>;
  update(id: string, text: string, opts?: { kind?: Kind; source?: string }): Promise<Memory>;
  forget(id: string): Promise<boolean>;
  /** Every memory in the scope, gone. For offboarding and "forget everything". Returns how many. */
  clear(): Promise<number>;
  /** Proposed changes, checked one by one: deletes first (they make room), then updates, then adds. */
  apply(ops: readonly Op[], opts?: { source?: string }): Promise<ApplyResult>;
  /** As many memories as fit in `budgetChars` of rendered prompt, newest change first. */
  recall(opts?: { budgetChars?: number }): Promise<{ memories: Memory[]; omitted: number }>;
};

const newId = () => `m_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

export function memlet(sql: Sql, options: StoreOptions): Store {
  const scope = options.scope;
  if (!scope) throw new Error("memlet: a scope is required");
  const max = options.max ?? DEFAULTS.max;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxAdds = options.maxAddsPerApply ?? DEFAULTS.maxAddsPerApply;
  const now = () => (options.now?.() ?? new Date()).toISOString();

  const list = () =>
    sql.all<Memory>("SELECT * FROM memlet_memories WHERE scope = ? ORDER BY updated_at DESC, id", [scope]);

  async function add(text: string, opts: { kind?: Kind; source?: string } = {}): Promise<Memory> {
    const kind = opts.kind ?? "fact";
    if (!isKind(kind)) throw new MemletError("bad_kind");
    const rows = await list();
    const refusal = refuse(text, maxChars, rows.map((m) => m.text));
    if (refusal) throw new MemletError(refusal);
    if (rows.length >= max) throw new MemletError("full");
    const at = now();
    const [row] = await sql.all<Memory>(
      "INSERT INTO memlet_memories (id, scope, text, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
      [newId(), scope, normalize(text), kind, opts.source ?? null, at, at],
    );
    return row as Memory;
  }

  async function update(id: string, text: string, opts: { kind?: Kind; source?: string } = {}): Promise<Memory> {
    if (opts.kind !== undefined && !isKind(opts.kind)) throw new MemletError("bad_kind");
    const rows = await list();
    const current = rows.find((m) => m.id === id);
    if (!current) throw new MemletError("unknown_id");
    const others = rows.filter((m) => m.id !== id).map((m) => m.text);
    const refusal = refuse(text, maxChars, others);
    if (refusal) throw new MemletError(refusal);
    const [row] = await sql.all<Memory>(
      "UPDATE memlet_memories SET text = ?, kind = ?, source = ?, updated_at = ? WHERE id = ? AND scope = ? RETURNING *",
      [normalize(text), opts.kind ?? current.kind, opts.source ?? current.source, now(), id, scope],
    );
    return row as Memory;
  }

  async function forget(id: string): Promise<boolean> {
    const rows = await sql.all("DELETE FROM memlet_memories WHERE id = ? AND scope = ? RETURNING id", [id, scope]);
    return rows.length > 0;
  }

  async function clear(): Promise<number> {
    const rows = await sql.all("DELETE FROM memlet_memories WHERE scope = ? RETURNING id", [scope]);
    return rows.length;
  }

  async function apply(ops: readonly Op[], opts: { source?: string } = {}): Promise<ApplyResult> {
    const result: ApplyResult = { applied: [], rejected: [] };
    const order = { delete: 0, update: 1, add: 2 } as const;
    const sorted = [...ops].sort((a, b) => order[a.op] - order[b.op]);
    let adds = 0;
    for (const op of sorted) {
      try {
        if (op.op === "delete") {
          if (!(await forget(op.id))) throw new MemletError("unknown_id");
        } else if (op.op === "update") {
          await update(op.id, op.text, { kind: op.kind, source: opts.source });
        } else {
          // Refused adds count too: a model that keeps proposing junk gets no extra tries.
          if (adds++ >= maxAdds) throw new MemletError("too_many_adds");
          await add(op.text, { kind: op.kind, source: opts.source });
        }
        result.applied.push(op);
      } catch (error) {
        if (!(error instanceof MemletError)) throw error;
        result.rejected.push({ op, reason: error.reason });
      }
    }
    return result;
  }

  async function recall(opts: { budgetChars?: number } = {}) {
    const budget = opts.budgetChars ?? 8000;
    const rows = await list();
    const memories: Memory[] = [];
    let used = 0;
    for (const m of rows) {
      // id, kind and the line's punctuation: about 30 characters on top of the text.
      const cost = m.text.length + 30;
      if (used + cost > budget) break;
      memories.push(m);
      used += cost;
    }
    return { memories, omitted: rows.length - memories.length };
  }

  return { scope, max, maxChars, list, add, update, forget, clear, apply, recall };
}
