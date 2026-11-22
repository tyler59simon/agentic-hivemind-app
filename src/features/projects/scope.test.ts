import { describe, expect, it } from "vitest";
import type { System } from "../../lib/lm";
import { systemsForProject } from "./scope";

const system = (slug: string, repos: string[], project?: string | null) => ({ slug, repos, project }) as System;
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

  describe("with a project field", () => {
    const some = [
      system("named", [], "pay"),
      system("elsewhere", ["C:/work/paystream"], "other"),
      system("blank", ["C:/work/paystream"], null),
      system("unset", ["C:/work/paystream"]),
    ];
    const forSlug = (slug: string, repos: string[]) => systemsForProject({ slug, repos }, some).map((s) => s.slug);

    it("matches a system by its project, and by repository only when it names none", () => {
      expect(forSlug("pay", ["C:/work/paystream"])).toEqual(["named", "blank", "unset"]);
      expect(forSlug("other", ["C:/work/paystream"])).toEqual(["elsewhere", "blank", "unset"]);
      expect(forSlug("pay", [])).toEqual(["named"]);
    });

    it("matches every system by repository when the caller gives no slug", () => {
      expect(slugs(["C:/work/paystream"], some)).toEqual(["elsewhere", "blank", "unset"]);
    });
  });
});
