// @vitest-environment jsdom
// NS-4B: the rail's Related section: the pages nearest in meaning, the memory notes Living Memory finds for the page's title
// and first words, the install hint when the model is missing, and what a click opens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (notebook: string, path: string, title: string, snippet = "") => ({ notebook, path, kind: "md", title, titleMarked: title, mtimeMs: 1, snippet });
let related: { pages: unknown[]; query: string; meaning: string } = { pages: [], query: "", meaning: "ready" };
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
/** What Living Memory says of each of the four notes it returns: the same four, best first, as it does. */
let scores: { similarity?: number; relevance?: number }[] = [];
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "index_related": return related;
      case "lm": {
        const argv = a.argv as string[];
        if (argv[0] === "search") {
          const notes = [1, 2, 3, 4].map((i) => ({ ...scores[i - 1], id: `demo:${i}`, domain: "demo", title: `Decision ${i}`, type: "decision", snippet: `why ${i}`, updated: "", tags: [], status: "active", score: 1, rank: i, engine: "lexical", revision: "r", sourceField: "body", sourceScope: "active" }));
          return { exit_code: 0, error: null, result: { mode: "lexical", domains: ["demo"], fallback: false, results: notes } };
        }
        return { exit_code: 0, error: null, result: {} };
      }
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RelatedPages } = await import("./RelatedPanel");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");

const file = { notebook: "nb-1", path: "Garden/Soil.md" };
const opened: { tab: Record<string, unknown>; split: boolean }[] = [];
let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RelatedPages file={file} /></QueryClientProvider>));
  await settle();
  return el;
}

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  related = { pages: [], query: "", meaning: "ready" };
  scores = [{ similarity: 0.71, relevance: 1 }, { similarity: 0.6, relevance: 0 }, { similarity: 0.52, relevance: 0.4 }, { similarity: 0.0443, relevance: 0 }];
  useApp.setState({ domain: "demo" });
  useWorkspace.setState({
    openTab: ((tab: Record<string, unknown>, opts?: { split?: boolean }) => { opened.push({ tab, split: !!opts?.split }); }) as never,
    openNote: ((ref: string, opts?: { split?: boolean; title?: string }) => { opened.push({ tab: { note: ref, title: opts?.title }, split: !!opts?.split }); }) as never,
  });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the rail's Related section", () => {
  it("lists the near pages and the three memory notes found for the page's words, and opens them", async () => {
    related = {
      pages: [hit("nb-1", "Garden/Compost.md", "Compost", "turn kitchen scraps into soil"), hit("nb-2", "Notes/Mulch.md", "Mulch")],
      query: "Soil how plants take up water", meaning: "ready",
    };
    const el = await mount();
    const sections = [...el.querySelectorAll("section")];
    expect(sections.map((s) => s.querySelector("h4")?.textContent)).toEqual(["Pages 2", "Memory notes 3"]);
    expect(sections[0].textContent).toContain("turn kitchen scraps into soil");
    // A page of another notebook shows its path.
    expect(sections[0].textContent).toContain("Notes/Mulch.md");
    expect(sections[0].textContent).not.toContain("Garden/Compost.md");
    // Living Memory was asked once, with the page's words, for three notes.
    const asked = calls.filter((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "search").map((c) => c.args.argv as string[]);
    expect(asked).toHaveLength(1);
    expect(asked[0].slice(0, 2)).toEqual(["search", "Soil how plants take up water"]);
    expect(asked[0]).toContain("3");
    // Four came back; the fourth is padding (similarity 0.0443), so three are shown.
    expect(sections[1].querySelectorAll(".back-row")).toHaveLength(3);
    await act(async () => { sections[0].querySelector<HTMLElement>(".back-row")!.click(); });
    expect(opened[0]).toMatchObject({ split: false, tab: { file: { notebook: "nb-1", path: "Garden/Compost.md" } } });
    await act(async () => { sections[1].querySelector<HTMLElement>(".back-row")!.click(); });
    expect(opened[1]).toMatchObject({ split: false, tab: { note: "demo:1", title: "Decision 1" } });
  });

  it("without the model, says how to install it and still lists the memory notes", async () => {
    related = { pages: [], query: "Soil", meaning: "missing" };
    const el = await mount();
    expect(el.querySelector(".semantic-hint")?.textContent).toContain("Semantic search needs the Living Memory model. Run alm semantic install.");
    expect(el.querySelectorAll("section")[1].querySelectorAll(".back-row")).toHaveLength(3);
  });

  it("says so when no page is close enough, and asks Living Memory for nothing when the page has no words", async () => {
    related = { pages: [], query: "", meaning: "ready" };
    const el = await mount();
    expect(el.textContent).toContain("No page is close enough in meaning to this one.");
    expect(calls.some((c) => c.cmd === "lm")).toBe(false);
    expect(el.textContent).toContain("No memory note comes close to this page.");
  });

  it("keeps a memory note only when its similarity reaches the floor of 0.45", async () => {
    scores = [{ similarity: 0.449, relevance: 0.9 }, { similarity: 0.45, relevance: 0 }, { similarity: 0.0443, relevance: 0 }, { similarity: 0, relevance: 0 }];
    related = { pages: [], query: "Soil", meaning: "ready" };
    const el = await mount();
    // Only the second is near enough; the first matched words but is not near in meaning.
    expect([...el.querySelectorAll("section")[1].querySelectorAll(".back-title")].map((t) => t.textContent)).toEqual(["Decision 2"]);
    expect(el.querySelector("section:nth-of-type(2) h4")?.textContent).toBe("Memory notes 1");
  });

  it("with no similarity (Living Memory's semantic search off) keeps the notes that have relevance above 0", async () => {
    scores = [{ relevance: 1 }, { relevance: 0 }, { relevance: 0.2 }, { relevance: 0 }];
    related = { pages: [], query: "Soil", meaning: "ready" };
    const el = await mount();
    expect([...el.querySelectorAll("section")[1].querySelectorAll(".back-title")].map((t) => t.textContent)).toEqual(["Decision 1", "Decision 3"]);
  });
});
