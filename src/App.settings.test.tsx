// @vitest-environment jsdom
// Opening Settings at a section scrolls to that section's heading, or to one automation's row when a link names it, and falls
// back to the section when the row is not there (Codex review of 857ec37, T2).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { useSettingsScroll } = await import("./App");
const { openAutomation, openSettings, useApp } = await import("./store");

const scrolled: string[] = [];
function Host() {
  useSettingsScroll();
  const ref = (el: HTMLElement | null) => { if (el) el.scrollIntoView = () => { scrolled.push(el.id); }; };
  return (
    <>
      {["settings-learning", "settings-spend", "settings-schedules", "settings-maintenance", "settings-shortcuts"].map((id) => <h3 key={id} id={id} ref={ref}>{id}</h3>)}
      <div id="automation-a1" ref={ref} />
    </>
  );
}

let root: Root | null = null;
async function open(go: () => void) {
  scrolled.length = 0;
  await act(async () => go());
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  return [...scrolled];
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useApp.setState({ settings: null });
  document.body.innerHTML = "";
});

describe("opening Settings at a section", () => {
  it("scrolls to the section, or to the named automation, and not when no section is named", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<Host />));
    expect(await open(() => openSettings("maintenance"))).toEqual(["settings-maintenance"]);
    expect(await open(() => openSettings("spend"))).toEqual(["settings-spend"]);
    expect(await open(() => openSettings("shortcuts"))).toEqual(["settings-shortcuts"]);
    expect(await open(() => openAutomation("a1"))).toEqual(["automation-a1"]);
    // A row that is not drawn (a removed automation) falls back to its section.
    expect(await open(() => openAutomation("gone"))).toEqual(["settings-schedules"]);
    expect(await open(() => openSettings())).toEqual([]);
  });
});
