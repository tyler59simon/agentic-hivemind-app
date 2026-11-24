// @vitest-environment jsdom
// Links in the reading view: web links go to the browser, and nothing else navigates.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PageView } from "./PageView";
import { relativeTarget } from "./pictures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

async function show(text: string) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<PageView text={text} tabId="t1" onLink={() => {}} pictures={{ folder: "Week" }} />); });
  return (label: string) => act(async () => { [...el.querySelectorAll("a")].find((a) => a.textContent === label)!.click(); });
}

describe("links in the reading view", () => {
  it("open a web link in the browser", async () => {
    const click = await show("[web](https://example.com)");
    await click("web");
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("do nothing for a relative link", async () => {
    const click = await show("[plan.pdf](plan.pdf)");
    await click("plan.pdf");
    expect(location.hash).toBe("");
  });
});

describe("relativeTarget", () => {
  it("resolves against the page's folder and refuses what leaves the root", () => {
    expect(relativeTarget("../assets/a%20b.pdf", "Week")).toBe("assets/a b.pdf");
    expect(relativeTarget("x.md#top", "")).toBe("x.md");
    for (const bad of ["../x.pdf", "file:///C:/x", "C:\\x.pdf", "/x.pdf", "mailto:a@b"]) expect(relativeTarget(bad, "")).toBeNull();
  });
});
