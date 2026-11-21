// @vitest-environment jsdom
// NS-3A: a page parked from another Living Memory store reads, opens and embeds nothing from the store connected now
// (Codex review of 398b956, P1).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const readDoc = vi.fn(async () => ({ text: "# Other" }));
const openPage = vi.fn();
const openAttachment = vi.fn(async () => {});
const toast = vi.fn();
vi.mock("../../documents/io", () => ({ readDoc: (...a: unknown[]) => readDoc(...(a as [])), attachBytes: vi.fn(), attachDropped: vi.fn() }));
vi.mock("./actions", () => ({ openPage: (...a: unknown[]) => openPage(...a) }));
vi.mock("../../documents/adapters/lmdoc", () => ({ openAttachment: (...a: unknown[]) => openAttachment(...(a as [])) }));
vi.mock("../../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import type { RichContext } from "../editor/rich/context";
import { useRichPage, type RichPage } from "./richPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function richFor(page: Partial<RichPage>): Promise<RichContext> {
  let got!: RichContext;
  function Probe() { got = useRichPage({ ref: { notebook: "lm:demo:plans", path: "Plans/A.md" }, files: ["Plans/A.md", "Plans/B.md"], lm: true, loose: false, follow: vi.fn(), takesLink: () => true, own: () => true, ...page }); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return got;
}

describe("a parked page", () => {
  it("embeds, follows and opens nothing while it belongs to another store", async () => {
    const follow = vi.fn();
    let own = false;
    const rich = await richFor({ follow, own: () => own });
    expect(await rich.readEmbed("B")).toBeNull();
    rich.openPage("B", false);
    rich.openHref("B.md", false);
    rich.openHref("../assets/1a2b3c4d-x.png", false);
    expect(readDoc).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
    expect(openPage).not.toHaveBeenCalled();
    expect(openAttachment).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("This page belongs to another Living Memory store, so its links do not open here.", "warn");

    own = true;
    expect(await rich.readEmbed("B")).toEqual({ title: "B", text: "# Other", path: "Plans/B.md" });
    rich.openPage("B", true);
    expect(follow).toHaveBeenCalledWith("B", true, undefined);
    rich.openHref("B.md", false);
    expect(openPage).toHaveBeenCalledWith({ notebook: "lm:demo:plans", path: "Plans/B.md" }, { split: false });
  });
});
