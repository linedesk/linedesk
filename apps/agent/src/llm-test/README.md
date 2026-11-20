# LLM test suite

Calls with edge cases against the real system prompt and tools, text only, graded by checks and an LLM judge. Command, keys, cost and the report: [docs/commands.md](../../../../docs/commands.md#llm-test-suite).

## Files

- `cases.ts`: the case catalogue (data only).
- `setups.ts`: the demo assistant and workspace a case builds its call from (Brightwater Plumbing & Heating, Maya, Mike Brennan; 555 numbers).
- `tools.ts`: the real tools with a fake API, as OpenAI function schemas.
- `conversation.ts`: one simulated call, with what the worker does around the model (greeting, tool rounds, end_call's closing flow, the nudge, the language rule, transfer lines).
- `model.ts`: the chat completions client, token and cost counts.
- `checks.ts`: the deterministic checks, and the problems looked for on every call (markdown, emojis, end_call with another tool, refused tool calls).
- `judge.ts`: the LLM judge (rubric of "must" and "must not" lines, answers `{pass, reasons}`).
- `run.ts`: the CLI.

## Add a case

1. Copy a case of the same category in `cases.ts`. The id starts with the category (`booking-...`).
2. `why`: the prompt rule it guards, in one line (the key in `packages/actions/src/prompt-texts.ts` where there is one).
3. `setup({...})`: hours, booking, transfers, caller (caller ID, saved contact, withheld, test call), languages, notes, history, lookups.
4. `turns` (what the caller says; `{ say, lang }` for another language) or `caller` (an LLM caller with a persona and a goal).
5. `sim`: what the fake world answers (free times, a failed calendar, a lookup answer, a declined collection step, a transfer that connects).
6. `checks` for what a pattern or a tool call can tell; `judge` for the rest. Keep both to what the prompt asks.
7. `severity`: `must` for safety and hard rules (every run passes), `should` for style and judgement (two in three).
8. `pnpm --filter @linedesk/agent test` (the catalogue is checked without a model), then `pnpm --filter @linedesk/agent llm-test --case <id>`.

A failing case is a finding about the prompt or the model unless the case itself is wrong. Never loosen a correct expectation to get green.
