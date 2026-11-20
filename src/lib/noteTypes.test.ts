import { describe, expect, it } from "vitest";
import { BUILTIN_TYPES, type NoteTypeDef } from "./lm";
import { NOT_CAPTURED, resolvable, typeClass, typeOptions } from "./noteTypes";

describe("note types", () => {
  it("gives built-in types their own colour and custom types a shared one", () => {
    expect(typeClass("decision")).toBe("type-decision");
    expect(typeClass("brief")).toBe("type-brief");
    expect(typeClass("incident")).toBe("type-custom");
    expect(BUILTIN_TYPES.map(typeClass)).not.toContain("type-custom");
  });

  it("offers the active types, plus the current one when it is not among them", () => {
    const def = (name: string): NoteTypeDef => ({
      name, builtin: false, status: "active", description: "", summary: "", sections: [], actions: false, review_days: null, concern: null, subject: null,
    });
    const active = [def("knowledge"), def("incident")];
    expect(typeOptions(active, "incident")).toEqual(["knowledge", "incident"]);
    expect(typeOptions(active, "postmortem")).toEqual(["knowledge", "incident", "postmortem"]);
    // The capture forms leave out brief, unless the note already is one.
    expect(typeOptions([...active, def("brief")], "knowledge", NOT_CAPTURED)).toEqual(["knowledge", "incident"]);
    expect(typeOptions([...active, def("brief")], "brief", NOT_CAPTURED)).toEqual(["knowledge", "incident", "brief"]);
  });

  it("resolves bugs and custom types that take Action items, and no other built-in", () => {
    const incident: NoteTypeDef = {
      name: "incident", builtin: false, status: "active", description: "", summary: "", sections: [], actions: true, review_days: null, concern: null, subject: null,
    };
    expect(resolvable("bug")).toBe(true);
    expect(resolvable("incident", incident)).toBe(true);
    expect(resolvable("incident", { ...incident, actions: false })).toBe(false);
    expect(resolvable("incident")).toBe(false);
    expect(resolvable("plan")).toBe(false);
    expect(resolvable("risk")).toBe(false);
    expect(resolvable("decision")).toBe(false);
  });
});
