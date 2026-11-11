import { describe, expect, it } from "vitest";
import type { System } from "../../lib/lm";
import { systemsForProject } from "./scope";

const system = (slug: string, repos: string[]) => ({ slug, repos }) as System;
const slugs = (repos: string[], systems: System[]) => systemsForProject({ repos }, systems).map((s) => s.slug);

describe("systemsForProject", () => {
  const all = [
    system("same", ["C:\\work\\paystream"]),
    system("inside", ["c:/work/paystream/services/ingestion/"]),
    system("around", ["C:/work"]),
    system("sibling", ["C:/work/paystream-tools"]),
    system("external", []),
  ];

  it("matches an equal, nested or enclosing repository, whatever the slashes and case", () => {
    expect(slugs(["c:/Work/PayStream"], all)).toEqual(["same", "inside", "around"]);
  });

  it("does not match a folder that only shares a name prefix, or a system with no repositories", () => {
    expect(slugs(["C:/work/paystream"], all)).not.toContain("sibling");
    expect(slugs(["C:/work/paystream"], all)).not.toContain("external");
  });

  it("finds nothing for a project without repositories", () => {
    expect(slugs([], all)).toEqual([]);
    expect(slugs([""], all)).toEqual([]);
  });
});
