// @vitest-environment jsdom
// CON-16: the Inbox card for a paused skill calls skill_resolve with the right action, and the merge sends the edited text.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PauseKind, Skill } from "../../lib/skills";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { SkillSyncCard } = await import("./SkillSyncCard");

const noteText = { description: "Use when the worker stalls", body: "## When to use\nNote version" };
const skillText = { description: "Use when the worker stalls", body: "## When to use\nSkill version" };
const skill = (kind: PauseKind, over: { noteText?: typeof noteText | null; skillText?: typeof skillText | null } = {}) => ({
  name: "ingest", description: "d", body: "b", archived: false,
  link: { note: "n1", domain: "demo", title: "Restart the worker", revision: "r", noteDigest: "d", version: 2,
    paused: { kind, reason: "Both sides changed since the last sync.", at: 1, noteText, skillText, ...over } },
}) as unknown as Skill;

let root: Root | null = null;
const done = vi.fn();
async function mount(s: Skill) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SkillSyncCard skill={s} onDone={done} /></QueryClientProvider>));
  return el;
}
/** The last button with this label: a dialog's button comes after the card's own. */
const button = (label: string) => { const all = [...document.querySelectorAll("button")].filter((b) => b.textContent === label); return all[all.length - 1] as HTMLButtonElement; };
const click = (label: string) => act(async () => { button(label).click(); await new Promise((r) => setTimeout(r, 0)); });
const resolves = () => invoke.mock.calls.filter(([cmd]) => cmd === "skill_resolve").map(([, args]) => args);
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

beforeEach(() => { invoke.mockClear(); done.mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("SkillSyncCard", () => {
  it("shows the title, the kind words, the reason and both texts", async () => {
    const el = await mount(skill("conflict"));
    expect(el.querySelector("h2")!.textContent).toBe("Sync paused: ingest");
    expect(el.textContent).toContain("The note and the skill both changed");
    expect(el.textContent).toContain("Both sides changed since the last sync.");
    expect(el.textContent).toContain("Restart the worker");
    expect([...el.querySelectorAll(".sync-text h3")].map((h) => h.textContent)).toEqual(["Note", "SKILL.md"]);
    expect(el.textContent).toContain("Note version");
    expect(el.textContent).toContain("Skill version");
  });

  it("keeps the skill file with no question, and calls skill_resolve with null text", async () => {
    await mount(skill("conflict"));
    await click("Keep the skill file");
    expect(resolves()).toEqual([{ name: "ingest", action: "skill", description: null, body: null }]);
    expect(done).toHaveBeenCalled();
  });

  it("asks before keeping the note when a skill text exists, then resolves note", async () => {
    await mount(skill("conflict"));
    await click("Keep the note");
    expect(resolves()).toEqual([]);
    expect(document.body.textContent).toContain("are replaced");
    await click("Keep the note"); // the dialog's confirm button
    expect(resolves()).toEqual([{ name: "ingest", action: "note", description: null, body: null }]);
  });

  it("asks before unlinking, then resolves unlink", async () => {
    await mount(skill("conflict"));
    await click("Unlink");
    expect(resolves()).toEqual([]);
    await click("Unlink"); // the dialog's confirm button
    expect(resolves()).toEqual([{ name: "ingest", action: "unlink", description: null, body: null }]);
  });

  it("merges with the edited text, prefilled from the skill file", async () => {
    const el = await mount(skill("conflict"));
    await click("Edit a merge");
    const description = el.querySelector("input") as HTMLInputElement;
    const body = el.querySelector("textarea") as HTMLTextAreaElement;
    expect(body.value).toBe(skillText.body);
    type(description, "Use when it stalls");
    type(body, "## When to use\nBoth");
    await click("Save");
    expect(resolves()).toEqual([{ name: "ingest", action: "merge", description: "Use when it stalls", body: "## When to use\nBoth" }]);
  });

  it("cancels a merge without calling the backend", async () => {
    await mount(skill("conflict"));
    await click("Edit a merge");
    await click("Cancel");
    expect(resolves()).toEqual([]);
    expect(button("Keep the note")).toBeTruthy();
  });

  it("prefills the merge from the note when there is no skill text", async () => {
    const el = await mount(skill("invalid_skill", { skillText: null }));
    expect(el.textContent).toContain("The skill file's text is not shown for this pause.");
    await click("Edit a merge");
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe(noteText.body);
  });

  it("keeps every action enabled for copies_differ and shows the guidance, and a merge works", async () => {
    await mount(skill("copies_differ"));
    for (const label of ["Keep the note", "Keep the skill file", "Edit a merge", "Unlink"]) expect(button(label).disabled).toBe(false);
    expect(document.body.textContent).toContain("Make the Claude Code and Codex copies the same");
    await click("Edit a merge");
    await click("Save");
    expect(resolves()).toEqual([{ name: "ingest", action: "merge", description: skillText.description, body: skillText.body }]);
  });

  it("keeps Keep the skill file enabled after a fix for invalid_skill and loose_text", async () => {
    await mount(skill("invalid_skill"));
    expect(button("Keep the skill file").disabled).toBe(false);
    expect(document.body.textContent).toContain("Add the missing section to SKILL.md, then choose Keep the skill file.");
    await click("Keep the skill file");
    expect(resolves()).toEqual([{ name: "ingest", action: "skill", description: null, body: null }]);
  });

  it("offers a gone note every action with guidance, and keeping the note needs no question without a skill text", async () => {
    const el = await mount(skill("note_missing", { noteText: null, skillText: null }));
    expect(el.textContent).toContain("The note is gone, archived or no longer a runbook");
    expect(el.textContent).toContain("Make the note an active runbook again");
    for (const label of ["Keep the note", "Keep the skill file", "Edit a merge", "Unlink"]) expect(button(label).disabled).toBe(false);
    await click("Keep the note");
    expect(resolves()).toEqual([{ name: "ingest", action: "note", description: null, body: null }]);
  });

  it("stays open when the backend refuses", async () => {
    invoke.mockRejectedValueOnce("The note was not found; unlink the skill");
    await mount(skill("note_missing", { noteText: null, skillText: null }));
    await click("Keep the note");
    expect(done).not.toHaveBeenCalled();
  });
});
