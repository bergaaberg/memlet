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
/**
 * The prompt in the order that caches: `system` never changes for a store's settings,
 * `parts.memories` changes only when a memory does, `parts.conversation` is new each
 * time. `user` is the two parts joined, for clients that send one string. To cache, put
 * a breakpoint after `system` and another after `parts.memories`.
 */
export type ReflectPrompt = {
    system: string;
    user: string;
    parts: {
        memories: string;
        conversation: string;
    };
    /** The memory ids behind the numbers the model sees: refs[0] is memory 1. Pass it to parseOps. */
    refs: string[];
};
/** Turns the app's model client into what memlet needs: a system prompt and one user message in, text out. */
export type Complete = (prompt: {
    system: string;
    user: string;
    parts?: ReflectPrompt["parts"];
}) => Promise<string>;
export type ReflectOptions = {
    /** Who the memories are about, in a few words: "the operator", "this publication's owner". */
    subject?: string;
    /** Most recent conversation text sent, in characters. Older turns are cut. */
    maxConversationChars?: number;
    /**
     * How many of `turns` were already reflected on: the `seen` of the last reflect over
     * this conversation. Only later turns are sent, with the one before them as context.
     */
    seen?: number;
    /** Skip the model call when the new user turns are only thanks and greetings. Default true. */
    gate?: boolean;
};
export declare function reflectPrompt(store: Pick<Store, "max" | "maxChars">, memories: readonly Memory[], turns: readonly Turn[], opts?: ReflectOptions): ReflectPrompt;
/**
 * The model's answer, as ops. Anything malformed is dropped and counted, never guessed at.
 * Pass `refs` from reflectPrompt to turn memory numbers back into ids; a number with no
 * memory behind it becomes an id no scope has, so apply() refuses it as unknown.
 */
export declare function parseOps(raw: string, refs?: readonly string[]): {
    ops: Op[];
    dropped: number;
};
export declare function isSmallTalk(text: string): boolean;
export type ReflectResult = ApplyResult & {
    dropped: number;
    /** Pass as `seen` next time this conversation is reflected on. */
    seen: number;
    /** Why no model call was made, when none was. */
    skipped?: "nothing_new" | "small_talk";
};
/** The whole write side in one call: read the memories, ask, check, apply. */
export declare function reflect(store: Store, turns: readonly Turn[], complete: Complete, opts?: ReflectOptions & {
    source?: string;
}): Promise<ReflectResult>;
