/**
 * The one call memlet makes: run a statement, get its rows back. Every SQLite an app is
 * likely to have fits it: D1, a Durable Object's own SQLite, and node:sqlite (local runs
 * and tests). Writes go through `all` too; the ones whose result matters say RETURNING.
 *
 * The adapters below are typed by shape, not by import, so this file never pulls in
 * `cloudflare:workers` or `node:sqlite` and runs in either place.
 */
export type SqlValue = string | number | null;
export interface Sql {
    all<T = Record<string, unknown>>(query: string, params?: SqlValue[]): Promise<T[]>;
}
type D1Like = {
    prepare(query: string): {
        bind(...params: SqlValue[]): {
            all<T>(): Promise<{
                results: T[];
            }>;
        };
    };
};
/** A D1 binding, or anything speaking its prepare/bind/all (mountainrange's src/db.ts does). */
export declare function fromD1(db: D1Like): Sql;
type DurableObjectSqlLike = {
    exec(query: string, ...params: SqlValue[]): {
        toArray(): unknown[];
    };
};
/** `ctx.storage.sql` inside a Durable Object. */
export declare function fromDurableObject(sql: DurableObjectSqlLike): Sql;
type NodeSqliteLike = {
    prepare(query: string): {
        all(...params: SqlValue[]): unknown[];
    };
};
/** A `DatabaseSync` from node:sqlite. */
export declare function fromNodeSqlite(db: NodeSqliteLike): Sql;
export {};
