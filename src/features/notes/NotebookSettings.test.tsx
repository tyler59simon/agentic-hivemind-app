// @vitest-environment jsdom
// Codex re-review of 75ce884, R2-P1: the reach fields report only the field the user touched, so a Private flag that
// changed while the dialog was open is never sent back as it was when the dialog opened.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReachFields } from "./NotebookSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = "" });

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
});
