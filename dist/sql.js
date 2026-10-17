/**
 * The one call memlet makes: run a statement, get its rows back. Every SQLite an app is
 * likely to have fits it: D1, a Durable Object's own SQLite, and node:sqlite (local runs
 * and tests). Writes go through `all` too; the ones whose result matters say RETURNING.
 *
 * The adapters below are typed by shape, not by import, so this file never pulls in
 * `cloudflare:workers` or `node:sqlite` and runs in either place.
 */
/** A D1 binding, or anything speaking its prepare/bind/all (mountainrange's src/db.ts does). */
export function fromD1(db) {
    return {
        async all(query, params = []) {
            const { results } = await db
                .prepare(query)
                .bind(...params)
                .all();
            return results;
        },
    };
}
/** `ctx.storage.sql` inside a Durable Object. */
export function fromDurableObject(sql) {
    return {
        async all(query, params = []) {
            return sql.exec(query, ...params).toArray();
        },
    };
}
/** A `DatabaseSync` from node:sqlite. */
export function fromNodeSqlite(db) {
    return {
        async all(query, params = []) {
            return db.prepare(query).all(...params);
        },
    };
}
