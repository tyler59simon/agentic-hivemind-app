# S6: Codex one-shot calls (verdict: partial; the live call waits for approval)

Checked on 2026-11-20 against codex-cli 0.169.0, offline only.

`codex exec` has `--json` (JSONL events), `--output-schema <FILE>`, `-o/--output-last-message <FILE>`, `--ephemeral`, `-s/--sandbox`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--strict-config`, `-C/--cd`, `-m/--model`, `-c key=value` overrides, `--add-dir` and `-i/--image`, and reads the prompt from stdin. It has no spending cap flag, no tool-free mode and no system-prompt flag.

One live call is still needed. It costs money, so it waits for the user's approval at the start of NS-8A. It will measure:

- which JSONL event carries token usage, and its field names;
- how strict `--output-schema` is (OpenAI structured outputs need every property listed in `required` and `additionalProperties: false`);
- whether `-c instructions=...` or a preface in the prompt is the better way to pass the action policy;
- whether `-c model_reasoning_effort=low` is honoured;
- whether there is managed configuration Hivemind must respect, as `managed.rs` does for Claude.

Until then, NS-8A's `run_codex` follows the README design, and Codex costs are settled as estimates.
