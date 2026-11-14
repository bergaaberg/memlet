import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario, scripted } from "../eval/quality.ts";
import { SCENARIOS } from "../eval/scenarios.ts";

// The eval's scenarios must hold with ideal answers, or a live run measures a broken case.
for (const s of SCENARIOS) {
  test(`eval scenario: ${s.name}`, async () => {
    const r = await runScenario(s, scripted(s));
    assert.deepEqual(r.failures, [], r.memories.join("\n"));
  });
}
