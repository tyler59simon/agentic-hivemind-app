import { describe, expect, it } from "vitest";
import { isShellId, NO_SHELL_PLACE, shellLabel, shellPlaces, shellStatus, shellTitle } from "./shells";

describe("shell tab text", () => {
  it("joins the label and the folder name", () => {
    expect(shellLabel({ label: "PowerShell", cwd: String.raw`C:\src\paystream` })).toBe("PowerShell · paystream");
    expect(shellLabel({ label: "PowerShell 7", cwd: "C:/src/paystream/" })).toBe("PowerShell 7 · paystream");
    expect(shellLabel({ label: null, cwd: null })).toBe("PowerShell");
    expect(shellTitle({ label: "PowerShell", cwd: String.raw`C:\src\paystream` })).toBe(String.raw`C:\src\paystream`);
  });
  it("tells shell ids from session ids", () => {
    expect(isShellId("shell-1a2b")).toBe(true);
    expect(isShellId("login-codex")).toBe(false);
  });
  it("reports running and exited", () => {
    expect(shellStatus({ running: true, exitCode: null })).toEqual({ tone: "on", text: "Running" });
    expect(shellStatus({ running: false, exitCode: 0 })).toEqual({ tone: "off", text: "Exited" });
    expect(shellStatus({ running: false, exitCode: 3 })).toEqual({ tone: "failed", text: "Exited with code 3" });
  });
});

describe("shellPlaces", () => {
  const base = { session: null, project: null, repo: null, other: false, folders: [] };
  it("prefers the active session's folder", () => {
    expect(shellPlaces({ ...base, session: "s1", project: "p", repo: "C:/r" })).toEqual([{ label: "PowerShell here", target: { session: "s1" } }]);
  });
  it("then the project's first repository", () => {
    expect(shellPlaces({ ...base, project: "p", repo: "C:/r" })).toEqual([{ label: "PowerShell here", target: { checkout: { project: "p", repo: "C:/r" } } }]);
    expect(shellPlaces({ ...base, project: "p" })).toEqual([]);
  });
  it("then each folder under Other folders", () => {
    expect(shellPlaces({ ...base, other: true, folders: [String.raw`C:\a\one`, String.raw`C:\b\two`] })).toEqual([
      { label: "one", target: { folder: String.raw`C:\a\one` } }, { label: "two", target: { folder: String.raw`C:\b\two` } },
    ]);
    expect(shellPlaces({ ...base, other: true })).toEqual([]);
  });
  it("is empty with nothing picked", () => {
    expect(shellPlaces(base)).toEqual([]);
    expect(NO_SHELL_PLACE.length).toBeGreaterThan(0);
  });
});
