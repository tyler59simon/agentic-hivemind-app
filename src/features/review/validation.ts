// What the agent ran to check its work, read off the session's own events. Nothing is asked of the agent.
import type { SeqEvent } from "../../lib/agent";

export type CheckKind = "test" | "build";
export interface Check { id: string; kind: CheckKind; command: string; outcome: "passed" | "failed" | "running"; seq: number }
export interface Validation { checks: Check[]; warning: string | null }

const SHELL = new Set(["Bash", "PowerShell", "Shell"]);
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SEGMENTS = /&&|\|\||[;|\n]/;
const PREFIX = /^(?:\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*|npx|bunx|pnpm\s+exec|sudo|time|uv\s+run|poetry\s+run|pipenv\s+run|bundle\s+exec|cross-env|\.\/|\.\\)\s*)*/;

/** What counts as a test run or a build. Each pattern is tried at the start of a command segment. */
export const CHECKS: { kind: CheckKind; pattern: RegExp }[] = [
  { kind: "test", pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?t(?:est)?\b/i },
  { kind: "test", pattern: /^(?:vitest|jest|mocha|ava)\b/i },
  { kind: "test", pattern: /^(?:playwright\s+test|cypress\s+run)\b/i },
  { kind: "test", pattern: /^cargo\s+(?:test|nextest)\b/i },
  { kind: "test", pattern: /^go\s+test\b/i },
  { kind: "test", pattern: /^(?:pytest|py\.test|tox|nox)\b/i },
  { kind: "test", pattern: /^py(?:thon[\d.]*)?\s+-m\s+(?:pytest|unittest)\b/i },
  { kind: "test", pattern: /^(?:mvn|mvnw|gradle|gradlew)(?:\.cmd|\.bat)?\s.*\b(?:test|verify|check)\b/i },
  { kind: "test", pattern: /^dotnet\s+test\b/i },
  { kind: "test", pattern: /^(?:rspec|phpunit|ctest)\b/i },
  { kind: "test", pattern: /^(?:deno|swift|mix|flutter|dart)\s+test\b/i },
  { kind: "test", pattern: /^(?:make|just)\s+(?:test|check)\b/i },
  { kind: "build", pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|lint|typecheck|check)\b/i },
  { kind: "build", pattern: /^(?:tsc|eslint|ruff|mypy|flake8|pylint)\b/i },
  { kind: "build", pattern: /^cargo\s+(?:build|check|clippy)\b/i },
  { kind: "build", pattern: /^go\s+(?:build|vet)\b/i },
  { kind: "build", pattern: /^(?:mvn|mvnw|gradle|gradlew)(?:\.cmd|\.bat)?\s.*\b(?:compile|package|install|build|assemble)\b/i },
  { kind: "build", pattern: /^dotnet\s+build\b/i },
  { kind: "build", pattern: /^(?:make|just)(?:\s+(?:all|build))?\s*$/i },
];

/** "test" or "build" when a shell command runs one, else null. A test anywhere in the command wins. */
export function classify(command: string): CheckKind | null {
  const kinds = command.split(SEGMENTS).map((segment) => {
    const rest = segment.replace(PREFIX, "").trim();
    return CHECKS.find((c) => c.pattern.test(rest))?.kind;
  });
  return kinds.includes("test") ? "test" : kinds.includes("build") ? "build" : null;
}

/** The checks a session ran and what is missing, from its events in order. */
export function validation(events: SeqEvent[], filesProposed: boolean): Validation {
  let checks: Check[] = [];
  let lastEdit = -1;
  for (const { seq, event } of events) {
    if (event.type === "toolUse") {
      if (EDITS.has(event.name)) lastEdit = seq;
      else if (SHELL.has(event.name)) {
        const kind = classify(event.summary);
        if (kind) checks = [...checks.filter((c) => c.command !== event.summary), { id: event.id, kind, command: event.summary, outcome: "running", seq }];
      }
    } else if (event.type === "toolResult") {
      const check = checks.find((c) => c.id === event.id);
      if (check) check.outcome = event.ok && !/^Exit code [1-9]/.test(event.summary) ? "passed" : "failed";
    }
  }
  const lastTest = checks.filter((c) => c.kind === "test").reduce((at, c) => Math.max(at, c.seq), -1);
  const warning = !filesProposed ? null
    : lastTest < 0 ? "The agent ran no tests in this session."
    : lastTest < lastEdit ? "No test command ran after the last file edit."
    : null;
  return { checks: checks.slice(-6), warning };
}
