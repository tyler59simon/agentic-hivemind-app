import { describe, expect, it } from "vitest";
import { anotherAccountWarning, authView } from "./auth";

describe("authView", () => {
  it("shows Signed in with the plan label and offers another account only", () => {
    expect(authView({ signedIn: true, detail: null }, false, false)).toEqual({ label: "Signed in", signIn: false, another: true });
    expect(authView({ signedIn: true, detail: "max" }, false, false).label).toBe("Signed in (max)");
  });

  it("offers Sign in when signed out", () => {
    expect(authView({ signedIn: false, detail: null }, false, false)).toEqual({ label: "Not signed in", signIn: true, another: false });
  });

  it("offers Sign in when the status is unknown or the check failed", () => {
    expect(authView({ signedIn: null, detail: null }, false, false)).toEqual({ label: "Could not check", signIn: true, another: false });
    expect(authView(undefined, false, true)).toEqual({ label: "Could not check", signIn: true, another: false });
  });

  it("offers nothing while it checks", () => {
    expect(authView(undefined, true, false)).toEqual({ label: "Checking…", signIn: false, another: false });
  });

  it("names the Codex sign-out trap and keeps Claude's confirmation plain", () => {
    expect(anotherAccountWarning("codex")).toContain("signed out of your current account");
    expect(anotherAccountWarning("claude")).not.toContain("signed out");
  });
});
