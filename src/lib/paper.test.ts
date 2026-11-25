// @vitest-environment jsdom
// Documents on white paper: the setting, its first-paint copy (sync between windows is in appearance.test.ts), and which colours a document draws in.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { announceDocumentLook, applyPaperDefault, documentIsDark, initPaperDefault, onDocumentLook, paperDefault, useWhitePaper } from "./paper";
import { prefs } from "./prefs";
import { applyTheme, type Theme } from "./theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => { initPaperDefault(); });
beforeEach(() => { localStorage.clear(); applyPaperDefault("theme", false); applyTheme("purple", false); });
afterEach(() => { document.body.innerHTML = ""; });

describe("the document background setting", () => {
  it("is the theme's background until it is changed, and an unknown value means the theme", () => {
    expect(prefs.paper()).toBe("theme");
    localStorage.setItem(prefs.paperKey, "sepia");
    expect(prefs.paper()).toBe("theme");
  });

  it("is kept on this computer", () => {
    applyPaperDefault("white");
    expect(localStorage.getItem(prefs.paperKey)).toBe("white");
    expect(prefs.paper()).toBe("white");
    expect(paperDefault()).toBe("white");
    applyPaperDefault("theme");
    expect(prefs.paper()).toBe("theme");
  });

  it("is not saved by applying a value that came from storage", () => {
    applyPaperDefault("white", false);
    expect(localStorage.getItem(prefs.paperKey)).toBeNull();
  });

  it("starts from the saved value", () => {
    localStorage.setItem(prefs.paperKey, "white");
    initPaperDefault();
    expect(paperDefault()).toBe("white");
  });
});

describe("whether a tab is on white paper", () => {
  function shown(tab: { paper?: boolean } | undefined) {
    const seen: boolean[] = [];
    const Probe = () => { seen.push(useWhitePaper(tab)); return null; };
    const root = createRoot(document.createElement("div"));
    return { seen, mount: () => act(async () => root.render(createElement(Probe))), root };
  }

  it("follows the setting unless the tab chose, and no tab is never on paper", async () => {
    const cases: [boolean | undefined, "theme" | "white", boolean][] = [
      [undefined, "theme", false], [undefined, "white", true], [true, "theme", true], [false, "white", false],
    ];
    for (const [paper, setting, white] of cases) {
      applyPaperDefault(setting, false);
      const p = shown({ paper });
      await p.mount();
      expect([paper, setting, p.seen[p.seen.length - 1]]).toEqual([paper, setting, white]);
      await act(async () => p.root.unmount());
    }
    const none = shown(undefined);
    applyPaperDefault("white", false);
    await none.mount();
    expect(none.seen[none.seen.length - 1]).toBe(false);
    await act(async () => none.root.unmount());
  });

  it("changes when the setting changes", async () => {
    const p = shown({});
    await p.mount();
    expect(p.seen[p.seen.length - 1]).toBe(false);
    await act(async () => applyPaperDefault("white", false));
    expect(p.seen[p.seen.length - 1]).toBe(true);
    await act(async () => p.root.unmount());
  });
});

describe("documentIsDark", () => {
  const themes: [Theme, boolean][] = [["purple", true], ["emerald", true], ["emerald-light", false]];
  const inside = (paper: boolean) => {
    const pane = document.createElement("div");
    if (paper) pane.setAttribute("data-paper", "");
    const child = document.createElement("span");
    pane.append(child);
    document.body.append(pane);
    return child;
  };

  it("follows the theme outside a white pane", () => {
    for (const [theme, dark] of themes) {
      applyTheme(theme, false);
      expect([theme, documentIsDark(inside(false))]).toEqual([theme, dark]);
      expect([theme, documentIsDark(null)]).toEqual([theme, dark]);
    }
  });

  it("is never dark inside a white pane, under every theme", () => {
    for (const [theme] of themes) {
      applyTheme(theme, false);
      expect([theme, documentIsDark(inside(true))]).toEqual([theme, false]);
    }
  });

  it("answers for the pane the element is in", () => {
    applyTheme("purple", false);
    const white = inside(true), plain = inside(false);
    expect([documentIsDark(white), documentIsDark(plain)]).toEqual([false, true]);
  });
});

describe("the change signal", () => {
  it("fires for a theme change and for an announced change of a pane, and stops when removed", () => {
    const seen = vi.fn();
    const stop = onDocumentLook(seen);
    applyTheme("emerald", false);
    expect(seen).toHaveBeenCalledTimes(1);
    announceDocumentLook();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    applyTheme("purple", false);
    announceDocumentLook();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
