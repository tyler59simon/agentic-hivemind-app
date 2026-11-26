// @vitest-environment jsdom
// Delete is a direct write confirmed in a dialog, sent with the revision the page shows. When the note changed since, the
// dialog says so after the note is read again, and the user's next click sends the new revision.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const shown = vi.hoisted(() => ({ revision: "rev1" }));
vi.mock("../viewer/NoteView", () => ({
  noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: async () => ({ id: "1", domain: "d", title: "T", type: "knowledge", status: "active", revision: shown.revision }) }),
}));

const lm = await import("../../lib/lm");
const { NoteMenu } = await import("./NoteMenu");

const sent: string[][] = [];
let stale = false;
lm.setTransport(async (_cmd, args) => {
  const argv = (args as { argv: string[] }).argv;
  if (argv[0] !== "delete") return { exit_code: 1, result: null, error: { code: "invalid", message: "not in this test" } };
  sent.push(argv);
  if (stale) return { exit_code: 6, result: null, error: { code: "stale", message: "stale_revision: d:1 changed since revision rev1; read it again and redo the change" } };
  return { exit_code: 0, error: null, result: { ok: true, operation_id: "d-1", state: "committed", kind: "delete", undo: "undo d-1" } };
});

let root: ReturnType<typeof createRoot> | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("deleting a note from its menu", () => {
  it("sends the revision the page shows, and the next one after a stale refusal", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><NoteMenu refId="d:1" /></QueryClientProvider>));
    await settle();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Note actions"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Delete…")!.click());

    stale = true;
    shown.revision = "rev2";
    await act(async () => button("Delete").click());
    await settle();
    expect(sent).toEqual([["delete", "d:1", "--domain", "d", "--expected-revision", "rev1"]]);
    expect(document.querySelector(".modal .error, [role=dialog] .error")?.textContent).toBe("This note changed; reloaded.");

    stale = false;
    await act(async () => button("Delete").click());
    await settle();
    expect(sent[1]).toEqual(["delete", "d:1", "--domain", "d", "--expected-revision", "rev2"]);
  });
});
