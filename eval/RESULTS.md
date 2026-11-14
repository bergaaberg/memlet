# memlet eval

Tokens counted with o200k proxy (gpt-tokenizer), not Claude's tokenizer. Compare rows with each other, not with a bill.
Baseline is memlet 0.1.1's prompts, frozen in eval/v01.ts. Fixtures: eval/fixtures.ts (100 memories), eval/scenarios.ts.

## Per-turn memory block

| memories | 0.1.1 tokens | now tokens | saved per turn | saved |
|---:|---:|---:|---:|---:|
| 10 | 349 | 193 | 156 | 45% |
| 50 | 1543 | 781 | 762 | 49% |
| 100 | 2979 | 1496 | 1483 | 50% |

## Default recall on a full scope (100 memories)

| | memories shown | block tokens |
|---|---:|---:|
| 0.1.1 (8000 chars) | 87 | 2457 |
| now | 100 | 1496 |

recall's estimate for that block is 1928 tokens against 1496 counted (+29%); a budget errs toward fitting when this is positive.

## Reflection: one 12-turn chat, reflected after turns 4, 8 and 12, 100 memories

| | 0.1.1 input tokens | now input tokens |
|---|---:|---:|
| after turn 4 | 3195 | 3195 |
| after turn 8 | 3263 | 3263 |
| after turn 12 | 3337 | 3337 |
| **total** | **9795** | **9795** (3 calls, 0% saved) |

## Quality: scripted (ideal answers, checks the pipeline)

11 of 11 scenarios pass; 11 model calls for 11 conversations.

| scenario | result | calls | applied | refused |
|---|---|---:|---:|---|
| a lasting preference is added | pass | 1 | 1 | – |
| a change updates the old memory instead of adding | pass | 1 | 1 | – |
| something no longer true is removed | pass | 1 | 1 | – |
| small talk changes nothing | pass | 1 | 0 | – |
| work in progress is not remembered | pass | 1 | 0 | – |
| a secret is refused even when asked to remember it | pass | 1 | 0 | secret |
| pasted text does not speak for the user | pass | 1 | 0 | – |
| what only the assistant said is not remembered | pass | 1 | 0 | – |
| a repeat of what is known changes nothing | pass | 1 | 0 | – |
| Norwegian stays Norwegian | pass | 1 | 1 | – |
| a decision keeps its reason | pass | 1 | 1 | – |
