/**
 * The store: one table, rows keyed by scope. A scope is whoever the memories are about
 * (an operator, a publication, a traveller); one scope never sees or changes another's
 * rows. In a Durable Object per scope the column is constant and costs nothing; in a
 * shared D1 it is the wall.
 *
 * Recall never writes. A "last used" stamp would turn every assistant turn into a row
 * write per memory, and writes are the meter that bills.
 *
 * Every change is also written to memlet_events, before the change itself: what the
 * memory said before and after, which call made it (its batch), and from where. That is
 * the history people can be shown and what undo() reverses. Undo checks that a memory is
 * still as the batch left it, so an event whose change never landed undoes nothing.
 */
import { isKind, normalize, refuse } from "./check.js";
import { BLOCK_TOKENS, lineTokens } from "./prompt.js";
/** Each statement on its own, for engines that take one at a time (D1's prepare). */
export const SCHEMA = [
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
    // 0.2: the history. Added, never altered; an app on 0.1 pastes SCHEMA_SQL again into a new migration.
    `CREATE TABLE IF NOT EXISTS memlet_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  batch TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  op TEXT NOT NULL,
  text TEXT,
  kind TEXT,
  prev_text TEXT,
  prev_kind TEXT,
  source TEXT,
  at TEXT NOT NULL
)`,
    "CREATE INDEX IF NOT EXISTS memlet_events_scope ON memlet_events (scope, seq)",
    "CREATE INDEX IF NOT EXISTS memlet_events_batch ON memlet_events (scope, batch)",
];
/** The same, as one file's worth: paste into an app's migrations folder. */
export const SCHEMA_SQL = `${SCHEMA.join(";\n\n")};\n`;
/** For engines without a migrations folder (a Durable Object's constructor, tests). Idempotent. */
export async function migrate(sql) {
    for (const statement of SCHEMA)
        await sql.all(statement);
}
export const DEFAULTS = { max: 100, maxChars: 280, maxAddsPerApply: 3, budgetTokens: 3000, historyMax: 1000 };
export class MemletError extends Error {
    reason;
    constructor(reason) {
        super(`memlet: ${reason}`);
        this.reason = reason;
    }
}
const hex = () => crypto.randomUUID().replaceAll("-", "");
const newId = () => `m_${hex().slice(0, 10)}`;
const newBatch = () => `b_${hex().slice(0, 12)}`;
export function memlet(sql, options) {
    const scope = options.scope;
    if (!scope)
        throw new Error("memlet: a scope is required");
    const max = options.max ?? DEFAULTS.max;
    const maxChars = options.maxChars ?? DEFAULTS.maxChars;
    const maxAdds = options.maxAddsPerApply ?? DEFAULTS.maxAddsPerApply;
    const now = () => (options.now?.() ?? new Date()).toISOString();
    const historyMax = options.historyMax ?? DEFAULTS.historyMax;
    const list = () => sql.all("SELECT * FROM memlet_memories WHERE scope = ? ORDER BY updated_at DESC, id", [scope]);
    /**
     * Write the event, then the change. If the change doesn't land, the event goes again;
     * if the process dies in between, undo finds the memory not as the event says and
     * leaves it alone. The other order could lose a change from the history.
     */
    async function logged(batch, change, write) {
        if (historyMax <= 0)
            return write();
        const [event] = await sql.all("INSERT INTO memlet_events (scope, batch, memory_id, op, text, kind, prev_text, prev_kind, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq", [scope, batch, change.memory_id, change.op, change.text, change.kind, change.prev_text, change.prev_kind, change.source, now()]);
        const drop = () => sql.all("DELETE FROM memlet_events WHERE seq = ? AND scope = ?", [event?.seq ?? -1, scope]);
        try {
            const result = await write();
            if (result === undefined)
                await drop();
            return result;
        }
        catch (error) {
            await drop();
            throw error;
        }
    }
    async function prune() {
        if (historyMax <= 0)
            return;
        await sql.all("DELETE FROM memlet_events WHERE scope = ? AND seq <= (SELECT seq FROM memlet_events WHERE scope = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)", [scope, scope, historyMax]);
    }
    /** One public call is one batch: run it, then prune if it changed anything. */
    async function single(run, changed = () => true) {
        const result = await run(newBatch());
        if (changed(result))
            await prune();
        return result;
    }
    async function addIn(batch, text, opts) {
        const kind = opts.kind ?? "fact";
        if (!isKind(kind))
            throw new MemletError("bad_kind");
        const rows = await list();
        const refusal = refuse(text, maxChars, rows.map((m) => m.text));
        if (refusal)
            throw new MemletError(refusal);
        if (rows.length >= max)
            throw new MemletError("full");
        const id = opts.id ?? newId();
        const clean = normalize(text);
        const source = opts.source ?? null;
        const at = now();
        const change = { memory_id: id, op: "add", text: clean, kind, prev_text: null, prev_kind: null, source };
        const row = await logged(batch, change, async () => {
            const [inserted] = await sql.all("INSERT INTO memlet_memories (id, scope, text, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *", [id, scope, clean, kind, source, at, at]);
            return inserted;
        });
        return row;
    }
    async function updateIn(batch, id, text, opts) {
        if (opts.kind !== undefined && !isKind(opts.kind))
            throw new MemletError("bad_kind");
        const rows = await list();
        const current = rows.find((m) => m.id === id);
        if (!current)
            throw new MemletError("unknown_id");
        const others = rows.filter((m) => m.id !== id).map((m) => m.text);
        const refusal = refuse(text, maxChars, others);
        if (refusal)
            throw new MemletError(refusal);
        const clean = normalize(text);
        const kind = opts.kind ?? current.kind;
        const source = opts.source ?? current.source;
        const change = { memory_id: id, op: "update", text: clean, kind, prev_text: current.text, prev_kind: current.kind, source };
        const row = await logged(batch, change, async () => {
            const [updated] = await sql.all("UPDATE memlet_memories SET text = ?, kind = ?, source = ?, updated_at = ? WHERE id = ? AND scope = ? RETURNING *", [clean, kind, source, now(), id, scope]);
            return updated;
        });
        if (!row)
            throw new MemletError("unknown_id");
        return row;
    }
    async function forgetIn(batch, id, source) {
        const [current] = await sql.all("SELECT * FROM memlet_memories WHERE id = ? AND scope = ?", [id, scope]);
        if (!current)
            return false;
        const change = { memory_id: id, op: "delete", text: null, kind: null, prev_text: current.text, prev_kind: current.kind, source };
        const gone = await logged(batch, change, async () => {
            const [row] = await sql.all("DELETE FROM memlet_memories WHERE id = ? AND scope = ? RETURNING id", [id, scope]);
            return row;
        });
        return gone !== undefined;
    }
    const add = (text, opts = {}) => single((batch) => addIn(batch, text, opts));
    const update = (id, text, opts = {}) => single((batch) => updateIn(batch, id, text, opts));
    async function forget(id, opts = {}) {
        if (opts.purge) {
            const rows = await sql.all("DELETE FROM memlet_memories WHERE id = ? AND scope = ? RETURNING id", [id, scope]);
            await sql.all("DELETE FROM memlet_events WHERE scope = ? AND memory_id = ?", [scope, id]);
            return rows.length > 0;
        }
        return single((batch) => forgetIn(batch, id, null), Boolean);
    }
    async function clear() {
        const rows = await sql.all("DELETE FROM memlet_memories WHERE scope = ? RETURNING id", [scope]);
        await sql.all("DELETE FROM memlet_events WHERE scope = ?", [scope]);
        return rows.length;
    }
    async function apply(ops, opts = {}) {
        const batch = newBatch();
        const result = { applied: [], rejected: [], batch: null };
        const order = { delete: 0, update: 1, add: 2 };
        const sorted = [...ops].sort((a, b) => order[a.op] - order[b.op]);
        let adds = 0;
        for (const op of sorted) {
            try {
                if (op.op === "delete") {
                    if (!(await forgetIn(batch, op.id, opts.source ?? null)))
                        throw new MemletError("unknown_id");
                }
                else if (op.op === "update") {
                    await updateIn(batch, op.id, op.text, { kind: op.kind, source: opts.source });
                }
                else {
                    // Refused adds count too: a model that keeps proposing junk gets no extra tries.
                    if (adds++ >= maxAdds)
                        throw new MemletError("too_many_adds");
                    await addIn(batch, op.text, { kind: op.kind, source: opts.source });
                }
                result.applied.push(op);
            }
            catch (error) {
                if (!(error instanceof MemletError))
                    throw error;
                result.rejected.push({ op, reason: error.reason });
            }
        }
        if (result.applied.length) {
            result.batch = batch;
            await prune();
        }
        return result;
    }
    function history(opts = {}) {
        const limit = opts.limit ?? 50;
        return opts.memoryId
            ? sql.all("SELECT * FROM memlet_events WHERE scope = ? AND memory_id = ? ORDER BY seq DESC LIMIT ?", [scope, opts.memoryId, limit])
            : sql.all("SELECT * FROM memlet_events WHERE scope = ? ORDER BY seq DESC LIMIT ?", [scope, limit]);
    }
    async function undo(target) {
        const name = target ?? (await sql.all("SELECT batch FROM memlet_events WHERE scope = ? ORDER BY seq DESC LIMIT 1", [scope]))[0]?.batch;
        const result = { undone: null, batch: null, reverted: [], rejected: [] };
        if (!name)
            return result;
        const events = await sql.all("SELECT * FROM memlet_events WHERE scope = ? AND batch = ? ORDER BY seq DESC", [scope, name]);
        if (!events.length)
            return result;
        result.undone = name;
        const batch = newBatch();
        const source = `undo:${name}`;
        for (const event of events) {
            try {
                const [current] = await sql.all("SELECT * FROM memlet_memories WHERE id = ? AND scope = ?", [event.memory_id, scope]);
                // Reverse only what still stands as this batch left it; anything later wins.
                const asLeft = event.op === "delete" ? !current : current?.text === event.text && current?.kind === event.kind;
                if (!asLeft)
                    throw new MemletError("changed_since");
                if (event.op === "add") {
                    if (!(await forgetIn(batch, event.memory_id, source)))
                        throw new MemletError("changed_since");
                }
                else if (event.op === "update") {
                    await updateIn(batch, event.memory_id, event.prev_text ?? "", { kind: event.prev_kind ?? undefined, source });
                }
                else {
                    await addIn(batch, event.prev_text ?? "", { kind: event.prev_kind ?? undefined, source, id: event.memory_id });
                }
                result.reverted.push(event);
            }
            catch (error) {
                if (!(error instanceof MemletError))
                    throw error;
                result.rejected.push({ event, reason: error.reason });
            }
        }
        if (result.reverted.length) {
            result.batch = batch;
            await prune();
        }
        return result;
    }
    async function recall(opts = {}) {
        const rows = await list();
        const byChars = opts.budgetChars !== undefined;
        // 0.1 counted characters: the text plus about 30 for id, kind and punctuation.
        const cost = byChars ? (m) => m.text.length + 30 : lineTokens;
        let left = byChars ? opts.budgetChars : (opts.budgetTokens ?? DEFAULTS.budgetTokens) - BLOCK_TOKENS;
        const memories = [];
        for (const m of rows) {
            left -= cost(m);
            if (left < 0)
                break;
            memories.push(m);
        }
        return { memories, omitted: rows.length - memories.length };
    }
    return { scope, max, maxChars, list, add, update, forget, clear, apply, history, undo, recall };
}
