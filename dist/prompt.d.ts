/**
 * Memories as the assistant sees them on every turn. Put the block after the stable part
 * of the system prompt and behind its own cache breakpoint: it changes only when a memory
 * does, so most turns read it from cache.
 */
import type { Memory } from "./store.ts";
export declare function memoryLines(memories: readonly Memory[]): string;
export declare function toPrompt(memories: readonly Memory[], opts?: {
    omitted?: number;
}): string;
