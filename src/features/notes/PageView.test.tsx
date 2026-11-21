// @vitest-environment jsdom
// Codex review of 32fee20, U2: a link Attach file wrote into a Living Memory page opens its attachment from the reading
// view; web links still go to the browser, and nothing else navigates.
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

async function show(text: string, onFile?: (path: string) => void) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<PageView text={text} tabId="t1" onLink={() => {}} onFile={onFile} pictures={{ folder: "Week" }} />); });
  return (label: string) => act(async () => { [...el.querySelectorAll("a")].find((a) => a.textContent === label)!.click(); });
}

describe("links in the reading view", () => {
  it("open an attachment by its path in the notebook", async () => {
    const onFile = vi.fn();
    const click = await show("[plan.pdf](../assets/1a2b3c4d-plan.pdf) [web](https://example.com) [up](../../x.pdf)", onFile);
    await click("plan.pdf");
    expect(onFile).toHaveBeenCalledWith("assets/1a2b3c4d-plan.pdf");
    await click("web");
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    await click("up");
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it("do nothing for a relative link where no handler is given (a folder notebook)", async () => {
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
