// @vitest-environment jsdom
// CON-16: a linked skill whose sync paused is an Inbox item beside the skill proposals, and the skills count adds both.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const skill = (name: string, paused: boolean) => ({
  name, archived: false, copies: [], notes: [], sessions: [], versions: [1], version: 1,
  link: { note: "n", domain: "demo", title: "T", revision: "r", noteDigest: "d", version: 1,
    paused: paused ? { kind: "conflict", reason: "r", at: 1, noteText: null, skillText: null } : null },
});
const proposal = { id: "p1", kind: "create", name: "new-one", state: "pending" };
const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "skills_list") return [skill("stuck", true), skill("fine", false)];
  if (cmd === "skill_proposals") return [proposal];
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { useInboxItems } = await import("./useInboxItems");

let root: Root | null = null;
let seen: { skills: number; syncs: string[]; proposals: number } | null = null;
function Probe() {
  const inbox = useInboxItems();
  seen = { skills: inbox.counts.skills, syncs: inbox.syncs.map((s) => s.name), proposals: inbox.skills.length };
  return null;
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("Inbox skill rows", () => {
  it("lists paused skills beside skill proposals and counts both", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Probe /></QueryClientProvider>));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(seen).toEqual({ skills: 2, syncs: ["stuck"], proposals: 1 });
  });
});
