import { describe, expect, it } from "vitest";
import type { RunEvent, SeqEvent } from "../../lib/agent";
import { classify, validation } from "./validation";

const seq = (events: RunEvent[]): SeqEvent[] => events.map((event, i) => ({ sessionId: "s", seq: i, at: i, event }));
const use = (id: string, name: string, summary: string): RunEvent => ({ type: "toolUse", id, name, summary });
const result = (id: string, ok: boolean, summary = ""): RunEvent => ({ type: "toolResult", id, ok, summary });
const edit = (id: string) => use(id, "Edit", "src/a.ts");
const test = (id: string) => use(id, "Bash", "npm test");

describe("validation", () => {
  it("classifies test and build commands", () => {
    for (const c of ["npm test", "npm run test:unit", "cd app && pnpm test -- --run", "FOO=1 npx vitest run", "cargo test --lib", "python -m pytest -q",
      "py -m unittest", "./gradlew test", "mvn -q verify", "go test ./...", "dotnet test", "make test"]) expect(classify(c), c).toBe("test");
    for (const c of ["npm run build", "npx tsc --noEmit", "cargo clippy", "make"]) expect(classify(c), c).toBe("build");
    expect(classify("npm run build && npm test")).toBe("test");
    for (const c of ["grep -r pytest .", "cat test.txt", "git status", "echo npm test", "ls"]) expect(classify(c), c).toBeNull();
  });

  it("takes the outcome from the tool result", () => {
    const outcome = (...events: RunEvent[]) => validation(seq(events), false).checks[0].outcome;
    expect(outcome(test("t1"), result("t1", true, "ok"))).toBe("passed");
    expect(outcome(test("t1"), result("t1", false, "boom"))).toBe("failed");
    expect(outcome(test("t1"), result("t1", true, "Exit code 1\nFAIL"))).toBe("failed");
    expect(outcome(test("t1"))).toBe("running");
  });

  it("shows a repeated command once, with its latest outcome", () => {
    const v = validation(seq([test("t1"), result("t1", false), edit("e1"), test("t2"), result("t2", true)]), true);
    expect(v.checks).toHaveLength(1);
    expect(v.checks[0]).toMatchObject({ id: "t2", outcome: "passed", command: "npm test" });
  });

  it("keeps the last six", () => {
    const events = Array.from({ length: 8 }, (_, i) => use(`t${i}`, "Bash", `npm test -- ${i}`));
    expect(validation(seq(events), false).checks.map((c) => c.id)).toEqual(["t2", "t3", "t4", "t5", "t6", "t7"]);
  });

  it("warns when tests did not follow the last edit", () => {
    expect(validation(seq([edit("e1"), test("t1"), edit("e2")]), true).warning).toBe("No test command ran after the last file edit.");
    expect(validation(seq([edit("e1"), edit("e2"), test("t1")]), true).warning).toBeNull();
    expect(validation(seq([edit("e1")]), true).warning).toBe("The agent ran no tests in this session.");
    expect(validation(seq([edit("e1")]), false).warning).toBeNull();
    expect(validation(seq([edit("e1"), test("t1"), edit("e2")]), false).warning).toBeNull();
  });

  it("ignores tools that are not a shell", () => {
    expect(validation(seq([use("r1", "Read", "npm test")]), false).checks).toEqual([]);
  });
});
