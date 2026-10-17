/**
 * The store: one table, rows keyed by scope. A scope is whoever the memories are about
 * (an operator, a publication, a traveller); one scope never sees or changes another's
 * rows. In a Durable Object per scope the column is constant and costs nothing; in a
 * shared D1 it is the wall.
 *
 * Recall never writes. A "last used" stamp would turn every assistant turn into a row
 * write per memory, and writes are the meter that bills.
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
export type Reason = Refusal | "full" | "unknown_id" | "too_many_adds";
export type ApplyResult = {
    applied: Op[];
    rejected: {
        op: Op;
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
};
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
    forget(id: string): Promise<boolean>;
    /** Every memory in the scope, gone. For offboarding and "forget everything". Returns how many. */
    clear(): Promise<number>;
    /** Proposed changes, checked one by one: deletes first (they make room), then updates, then adds. */
    apply(ops: readonly Op[], opts?: {
        source?: string;
    }): Promise<ApplyResult>;
    /** As many memories as fit in `budgetChars` of rendered prompt, newest change first. */
    recall(opts?: {
        budgetChars?: number;
    }): Promise<{
        memories: Memory[];
        omitted: number;
    }>;
};
export declare function memlet(sql: Sql, options: StoreOptions): Store;
