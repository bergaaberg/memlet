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
import { type Kind, type Refusal } from "./check.ts";
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
export type Op = {
    op: "add";
    text: string;
    kind: Kind;
} | {
    op: "update";
    id: string;
    text: string;
    kind?: Kind;
} | {
    op: "delete";
    id: string;
};
export type Reason = Refusal | "full" | "unknown_id" | "too_many_adds" | "changed_since";
export type ApplyResult = {
    applied: Op[];
    rejected: {
        op: Op;
        reason: Reason;
    }[];
    /** The id the history files this call's changes under, for undo(); null when nothing changed. */
    batch: string | null;
};
/** One change to one memory, as memlet_events keeps it. */
export type MemoryEvent = {
    seq: number;
    scope: string;
    batch: string;
    memory_id: string;
    op: "add" | "update" | "delete";
    /** After the change; null for a delete. */
    text: string | null;
    kind: Kind | null;
    /** Before the change; null for an add. */
    prev_text: string | null;
    prev_kind: Kind | null;
    source: string | null;
    at: string;
};
export type UndoResult = {
    /** The batch that was undone, or null when there was nothing to undo. */
    undone: string | null;
    /** The undo's own batch: undo that to redo. Null when nothing changed. */
    batch: string | null;
    reverted: MemoryEvent[];
    rejected: {
        event: MemoryEvent;
        reason: Reason;
    }[];
};
/** Each statement on its own, for engines that take one at a time (D1's prepare). */
export declare const SCHEMA: readonly string[];
/** The same, as one file's worth: paste into an app's migrations folder. */
export declare const SCHEMA_SQL: string;
/** For engines without a migrations folder (a Durable Object's constructor, tests). Idempotent. */
export declare function migrate(sql: Sql): Promise<void>;
export declare const DEFAULTS: {
    readonly max: 100;
    readonly maxChars: 280;
    readonly maxAddsPerApply: 3;
    readonly budgetTokens: 3000;
    readonly historyMax: 1000;
};
export type StoreOptions = {
    scope: string;
    /** Most memories one scope may hold. At the cap an add is refused until something is merged or deleted. */
    max?: number;
    /** Longest memory, in characters. */
    maxChars?: number;
    /** Most adds one apply() may make, so one chatty conversation can't fill the memory. */
    maxAddsPerApply?: number;
    /** Events kept per scope; older ones are pruned after each write. 0 keeps no history (and undo has nothing). */
    historyMax?: number;
    now?: () => Date;
};
export declare class MemletError extends Error {
    readonly reason: Reason;
    constructor(reason: Reason);
}
export type Store = {
    readonly scope: string;
    readonly max: number;
    readonly maxChars: number;
    /** Newest change first. */
    list(): Promise<Memory[]>;
    add(text: string, opts?: {
        kind?: Kind;
        source?: string;
    }): Promise<Memory>;
    update(id: string, text: string, opts?: {
        kind?: Kind;
        source?: string;
    }): Promise<Memory>;
    /**
     * Delete one memory. It stays in the history, so undo() can bring it back; with
     * `purge` its history goes too, for "delete this and keep no trace".
     */
    forget(id: string, opts?: {
        purge?: boolean;
    }): Promise<boolean>;
    /** Every memory in the scope, and its history, gone. For offboarding and "forget everything". Returns how many. */
    clear(): Promise<number>;
    /** Proposed changes, checked one by one: deletes first (they make room), then updates, then adds. */
    apply(ops: readonly Op[], opts?: {
        source?: string;
    }): Promise<ApplyResult>;
    /** The scope's changes, newest first. */
    history(opts?: {
        limit?: number;
        memoryId?: string;
    }): Promise<MemoryEvent[]>;
    /**
     * Reverse one batch: the latest, or the one named. Each change is reversed only if the
     * memory is still as the batch left it, and through the same checks as any write.
     */
    undo(batch?: string): Promise<UndoResult>;
    /**
     * As many memories as fit in `budgetTokens` (estimated) of toPrompt's block, newest change
     * first. `budgetChars` is 0.1's budget, kept for callers that pass it.
     */
    recall(opts?: {
        budgetTokens?: number;
        budgetChars?: number;
    }): Promise<{
        memories: Memory[];
        omitted: number;
    }>;
};
export declare function memlet(sql: Sql, options: StoreOptions): Store;
