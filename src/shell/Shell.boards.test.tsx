// @vitest-environment jsdom
// Escape in focus mode with the real canvas and draw.io boards (DESK-LAYOUT, review C5): a board that uses Escape (it clears its
// selection) keeps it, so the same press does not also leave focus mode; the next Escape, with nothing left to clear, does.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = vi.hoisted(() => ({ show: "canvas" as "canvas" | "drawio" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("../features/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => <div className="project-switcher static">Project</div> }));
vi.mock("../features/review/useInboxItems", () => ({ useInboxItems: () => ({ total: 0 }) }));
vi.mock("../lib/connection", () => ({ useSystemsEnabled: () => false }));
vi.mock("./Topbar", () => ({ Topbar: () => <header className="topbar" /> }));
vi.mock("../features/notes/NotesPage", () => ({ NotesPage: () => null }));
vi.mock("../features/agents/AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("../features/review/InboxPage", () => ({ InboxPage: () => null }));
vi.mock("../features/notes/PageView", () => ({ PageView: () => null }));
vi.mock("../features/home/HomePage", async () => {
  const { default: CanvasEditor } = await import("../features/canvas/CanvasEditor");
  const { default: DrawioEditor } = await import("../features/drawio/DrawioEditor");
  const canvas = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "card a", x: 0, y: 0, width: 100, height: 50 }], edges: [] });
  const drawio = `<mxfile host="Test"><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="API" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="70" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>`;
  const ctx = { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: () => {}, openHref: () => {}, fail: () => {}, notebook: null };
  return {
    HomePage: () => page.show === "canvas"
      ? <CanvasEditor text={canvas} readOnly={false} ctx={ctx as never} pictures={{ base: "", folder: "", files: [] }} notebook="nb" onOpenFile={() => {}} onChange={() => {}} />
      : <DrawioEditor text={drawio} readOnly={false} fileName="a.drawio" onChange={() => {}} />,
  };
});

const { Shell } = await import("./Shell");
const { useLayout } = await import("./layout");
const { useApp } = await import("../store");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

let root: Root | null = null;
const mount = async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Shell info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
};
const key = (target: Element) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(e); });
  return e;
};
const down = (el: Element) => act(async () => { el.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, bubbles: true, cancelable: true }), { pointerId: 1 })); });
const up = () => act(async () => { window.dispatchEvent(Object.assign(new MouseEvent("pointerup", { clientX: 5, clientY: 5, button: 0, bubbles: true }), { pointerId: 1 })); });

beforeEach(() => {
  useLayout.setState({ focusMode: true, sidebarCollapsed: false });
  useApp.setState({ route: { page: "home" }, back: [] });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useLayout.setState({ focusMode: false });
  document.body.innerHTML = "";
});

describe("Escape on a board in focus mode", () => {
  it("the canvas keeps the Escape that clears its selection, and the next one leaves focus mode", async () => {
    page.show = "canvas";
    await mount();
    const board = document.querySelector(".canvas-board")!;
    const card = document.querySelector('[data-node-id="a"]')!;
    await down(card);
    await up();
    const first = key(board);
    expect(first.defaultPrevented).toBe(true);
    expect(useLayout.getState().focusMode).toBe(true);
    const second = key(board);
    expect(second.defaultPrevented).toBe(true); // the shell took it
    expect(useLayout.getState().focusMode).toBe(false);
  });

  it("draw.io keeps the Escape that clears its selection, and the next one leaves focus mode", async () => {
    page.show = "drawio";
    await mount();
    const shell = document.querySelector(".drawio-shell")!;
    await down(document.querySelector("[data-drawio-cell='a']")!);
    await up();
    expect(document.querySelector(".drawio-node.on")).not.toBeNull();
    expect(key(shell).defaultPrevented).toBe(true);
    expect(document.querySelector(".drawio-node.on")).toBeNull();
    expect(useLayout.getState().focusMode).toBe(true);
    key(shell);
    expect(useLayout.getState().focusMode).toBe(false);
  });
});
