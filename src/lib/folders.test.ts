import { describe, expect, it } from "vitest";
import { OTHER_FOLDERS, realProject, samePath } from "./folders";

describe("realProject", () => {
  it("keeps a slug and drops everything that is not a project", () => {
    expect(realProject("paystream")).toBe("paystream");
    expect(realProject(OTHER_FOLDERS)).toBeNull();
    expect(realProject("~other")).toBeNull();
    expect(realProject(null)).toBeNull();
    expect(realProject(undefined)).toBeNull();
    expect(realProject("")).toBeNull();
  });
});

describe("samePath", () => {
  it("ignores slashes, a trailing slash and case", () => {
    expect(samePath("C:\\Src\\App", "c:/src/app/")).toBe(true);
    expect(samePath("C:/src/app", "C:/src/app2")).toBe(false);
    expect(samePath("C:/src/app", "C:/src")).toBe(false);
  });
});
