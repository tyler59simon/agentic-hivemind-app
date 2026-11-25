// @vitest-environment jsdom
// The axe helper itself: it finds violations, accepts a recorded baseline, and fails on a new violation and on a stale entry.
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, expectNoNewAxeViolations } from "./axe";

afterEach(() => { document.body.innerHTML = ""; });

describe("the axe helper", () => {
  const bad = '<main><button class="x"></button><img src="a.png"></main>';

  it("reports one entry per failing node, with the rule, selector and help text", async () => {
    document.body.innerHTML = bad;
    const found = await axeViolations(document.body);
    expect(found.map((v) => v.id).sort()).toEqual(["button-name", "image-alt"]);
    expect(found.find((v) => v.id === "button-name")).toMatchObject({ impact: "critical", target: "button", help: "Buttons must have discernible text" });
  });

  it("passes when the baseline matches, by rule or by rule and selector", async () => {
    document.body.innerHTML = bad;
    await expectNoNewAxeViolations(document.body, ["button-name @ button", "image-alt"]);
  });

  it("names a violation that is not in the baseline", async () => {
    document.body.innerHTML = bad;
    await expect(expectNoNewAxeViolations(document.body, ["image-alt"])).rejects.toThrow(/button-name \(critical\) at button[\s\S]*Buttons must have discernible text/);
  });

  it("fails on a baseline entry that no longer occurs", async () => {
    document.body.innerHTML = bad;
    await expect(expectNoNewAxeViolations(document.body, ["button-name", "image-alt", "link-name @ a"])).rejects.toThrow(/no longer occur[\s\S]*link-name @ a/);
  });

  it("does not run the rules jsdom cannot judge", async () => {
    document.body.innerHTML = '<div><button style="width:1px;height:1px">x</button></div>';
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
