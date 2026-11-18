import { describe, expect, it } from "vitest";
import type { System } from "../../lib/lm";
import { changedFields } from "./ProposedFields";

describe("changedFields", () => {
  it("lists current and proposed values for each proposed field", () => {
    const system = { slug: "s", owners: ["a"], depends_on: [], description: "Old" } as unknown as System;
    expect(changedFields(system, { slug: "s", owners: ["a", "b"], depends_on: ["x"], description: "New" })).toEqual([
      { field: "owners", before: "a", after: "a, b" },
      { field: "depends_on", before: "(none)", after: "x" },
      { field: "description", before: "Old", after: "New" },
    ]);
  });
});
