// @vitest-environment jsdom
// REG-30: no web picture is loaded, by the CSP or by the renderers.
// @ts-expect-error no @types/node package (as in src/test/css.ts). The path is from the repo root, where vitest runs.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../ui/Markdown";
import { PageView } from "../features/notes/PageView";
import { isWebUrl, webImageNote } from "./webImage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

async function render(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(node); });
  return el;
}

describe("web images (REG-30)", () => {
  it("knows a web address and names its host", () => {
    for (const web of ["https://example.com/a.png", "http://example.com/a.png", "//example.com/a.png", "HTTPS://EXAMPLE.COM/A.PNG"]) expect(isWebUrl(web), web).toBe(true);
    for (const other of ["a.png", "img/a.png", "/a.png", "data:image/png;base64,AA", "file:///C:/a.png", "hmfile://localhost/a.png"]) expect(isWebUrl(other), other).toBe(false);
    expect(webImageNote("https://tracker.example/?d=secret")).toBe("Web image not shown (tracker.example)");
    expect(webImageNote("img/a.png")).toBeNull();
    expect(webImageNote(undefined)).toBeNull();
  });

  it("draws no img for a picture in agent and note Markdown, and names the host of a web one", async () => {
    const el = await render(<Markdown>{"Look ![chart](https://tracker.example/x.png?d=secret) and ![local](a.png)"}</Markdown>);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("[chart] Web image not shown (tracker.example)");
    expect(el.textContent).toContain("[local]");
  });

  it("draws no img for a web picture in a notebook page", async () => {
    const el = await render(<PageView text={"![cat](https://example.com/cat.png)"} tabId="t1" onLink={() => {}} pictures={{ base: "http://hmfile.localhost/g/", folder: "" }} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("Web image not shown (example.com)");
  });

  it("leaves web sources out of the CSP's img-src", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8") as string) as { app: { security: { csp: string } } };
    const imgSrc = conf.app.security.csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
    expect(imgSrc).toBeDefined();
    const sources = imgSrc!.split(/\s+/).slice(1);
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
    expect(sources).not.toContain("*");
    for (const s of sources.filter((x) => /^https?:\/\//.test(x))) expect(s).toBe("http://hmfile.localhost");
  });
});
