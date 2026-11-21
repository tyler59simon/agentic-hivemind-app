// @vitest-environment jsdom
// Codex re-review of 75ce884, R2-P1: the reach fields report only the field the user touched, so a Private flag that
// changed while the dialog was open is never sent back as it was when the dialog opened.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { setTransport } from "../../lib/lm";
import { LmNotebookSettings, ReachFields } from "./NotebookSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; setTransport(invoke as Parameters<typeof setTransport>[0]); });

describe("agent reach in notebook settings", () => {
  it("a click on a visibility reports the visibility alone", async () => {
    const changes: unknown[] = [];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<ReachFields value={{ visibility: "searchable", private: false }} onChange={(c) => changes.push(c)} />));
    const radios = el.querySelectorAll<HTMLInputElement>("input[type=radio]");
    await act(async () => radios[0].click());
    const box = el.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => box.click());
    expect(changes).toEqual([{ visibility: "hidden" }, { private: true }]);
  });

  it("R3-P1: a field set back to what the dialog showed is still sent, since the notebook may have changed since", async () => {
    const sent: string[][] = [];
    setTransport(async (_cmd, a) => { sent.push(a.argv as string[]); return { exit_code: 0, result: {}, error: null }; });
    const nb = { domain: "demo", notebook: "plans", title: "Plans", visibility: "searchable", private: true, pages: 1, assets: 0 } as never;
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><LmNotebookSettings nb={nb} onClose={() => {}} /></QueryClientProvider>));
    const box = document.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => box.click());
    await act(async () => box.click());
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => save.click());
    expect(sent).toEqual([["doc", "notebook", "update", "--private", "--include-private", "--", "demo", "plans"]]);
  });
});
