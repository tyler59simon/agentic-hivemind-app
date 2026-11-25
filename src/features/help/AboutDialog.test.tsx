// @vitest-environment jsdom
// About Hivemind (DESK-HELP): the versions and folders from `app_info`, Copy buttons, loading and error states, and the
// Living Memory connection read from the existing "connect" query.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = {
  version: "0.1.0", tauri: "2.12.5", webviewEngine: "WebView2", webview: "140.0.1", os: "windows", arch: "x86_64", osVersion: "Windows 11 (build 26100)",
  dataDir: "C:\\Users\\a\\AppData\\Roaming\\hivemind", configDir: "C:\\Users\\a\\AppData\\Roaming\\hivemind-config", logDir: "C:\\Users\\a\\AppData\\Local\\hivemind\\logs",
};
let reply: () => Promise<unknown> = async () => info;
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { AboutDialog, useAboutDialog } = await import("./AboutDialog");
const { Announcer } = await import("../../ui/announce");

let root: Root | null = null;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const rows = () => [...document.querySelectorAll(".about-row")].map((r) => `${r.querySelector("dt")!.textContent} = ${r.querySelector("dd")!.textContent}`);
const writeText = vi.fn(async (_text: string) => {});

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => { if (cmd === "app_info") return reply(); return null; });
  reply = async () => info;
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.innerHTML = '<main id="page"><button id="opener">Opener</button></main>';
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><AboutDialog /><Announcer /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => useAboutDialog.getState().hide());
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the About dialog", () => {
  it("is closed until asked, then shows the versions and the three folders", async () => {
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => useAboutDialog.getState().show());
    await settle();
    expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-label")).toBe("About Hivemind");
    const all = rows();
    expect(all).toContain("Hivemind = 0.1.0");
    expect(all).toContain("Tauri = 2.12.5");
    expect(all).toContain("WebView2 = 140.0.1");
    expect(all).toContain("System = windows x86_64, Windows 11 (build 26100)");
    expect(all.find((r) => r.startsWith("Data folder"))).toContain(info.dataDir);
    expect(all.find((r) => r.startsWith("Config folder"))).toContain(info.configDir);
    expect(all.find((r) => r.startsWith("Log folder"))).toContain(info.logDir);
  });

  it("copies a folder, says Copied to a screen reader, and shows it on the button", async () => {
    await act(async () => useAboutDialog.getState().show());
    await settle();
    expect(document.querySelectorAll(".about-row button")).toHaveLength(3);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Copy the log folder"]')!;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(info.logDir);
    expect(button.textContent).toBe("Copied");
    expect(document.querySelector('[data-announce="polite"]')!.textContent).toBe("Copied");
  });

  it("says so, in the dialog and to a screen reader, when the copy is refused, and clears an earlier Copied", async () => {
    await act(async () => useAboutDialog.getState().show());
    await settle();
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Copy the data folder"]')!;
    await act(async () => button.click());
    expect(button.textContent).toBe("Copied");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => button.click());
    expect(document.querySelector('[data-announce="assertive"]')!.textContent).toBe("Could not copy");
    expect(button.textContent).toBe("Copy");
    expect(button.closest(".about-row")!.querySelector(".error")!.textContent).toContain("Could not copy");
    // The other folders show nothing, and a later success removes the message.
    expect(document.querySelectorAll(".about-row .error")).toHaveLength(1);
    await act(async () => button.click());
    expect(button.textContent).toBe("Copied");
    expect(document.querySelectorAll(".about-row .error")).toHaveLength(0);
  });

  it("shows a loading state, then an error state when app_info fails, without folders", async () => {
    let fail: (e: unknown) => void = () => {};
    reply = () => new Promise((_, reject) => { fail = reject; });
    await act(async () => useAboutDialog.getState().show());
    expect(document.querySelector(".modal-body")!.textContent).toContain("Loading");
    await act(async () => fail(new Error("no data folder")));
    await settle();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("no data folder");
    expect(rows().some((r) => r.startsWith("Data folder"))).toBe(false);
    expect(document.querySelector(".modal-body")!.textContent).not.toContain("Loading");
  });

  it("shows the Living Memory connection from the connect query, and does not ask Living Memory itself", async () => {
    client.setQueryData(["connect"], { version: { api: 7, python: "3.12", commands: [] }, root: "/lm", program: "p", script: "s" });
    await act(async () => useAboutDialog.getState().show());
    await settle();
    expect(rows()).toContain("Living Memory = Connected, API version 7");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["app_info"]);
  });

  it("says not connected when the connect query failed", async () => {
    await client.fetchQuery({ queryKey: ["connect"], queryFn: async () => { throw new Error("no lm"); }, retry: false }).catch(() => {});
    await act(async () => useAboutDialog.getState().show());
    await settle();
    expect(rows()).toContain("Living Memory = Not connected");
  });

  it("closes with Escape and gives the focus back to what asked for it", async () => {
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    await act(async () => useAboutDialog.getState().show());
    await settle();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
