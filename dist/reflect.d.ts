import type { ApplyResult, Memory, Op, Store } from "./store.ts";
/**
 * A turn as the user and assistant said it. Leave tool calls and their results out:
 * mail, web pages and database rows can say "remember this" too, and none of them
 * speaks for the user.
 */
export type Turn = {
    role: "user" | "assistant";
    text: string;
};
/** Turns the app's model client into what memlet needs: a system prompt and one user message in, text out. */
export type Complete = (prompt: {
    system: string;
    user: string;
}) => Promise<string>;
export type ReflectOptions = {
    /** Who the memories are about, in a few words: "the operator", "this publication's owner". */
    subject?: string;
    /** Most recent conversation text sent, in characters. Older turns are cut. */
    maxConversationChars?: number;
};
export declare function reflectPrompt(store: Pick<Store, "max" | "maxChars">, memories: readonly Memory[], turns: readonly Turn[], opts?: ReflectOptions): {
    system: string;
    user: string;
};
/** The model's answer, as ops. Anything malformed is dropped and counted, never guessed at. */
export declare function parseOps(raw: string): {
    ops: Op[];
    dropped: number;
};
/** The whole write side in one call: read the memories, ask, check, apply. */
export declare function reflect(store: Store, turns: readonly Turn[], complete: Complete, opts?: ReflectOptions & {
    source?: string;
}): Promise<ApplyResult & {
    dropped: number;
}>;
