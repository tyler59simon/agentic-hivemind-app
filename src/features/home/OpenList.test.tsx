// @vitest-environment jsdom
// Home's open list mounted for real: the sections, a tick that offers Undo, and the Undo that clears the box again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Milestone } from "../../lib/executive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tickTask = vi.fn(async () => undefined);
vi.mock("../notes/useTaskItems", () => ({ tickTask, openSource: vi.fn() }));
vi.mock("../notes/pageWrite", () => ({ refreshLists: vi.fn() }));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { OpenList, useTick } = await import("./OpenList");
const { homeSections } = await import("./home");
const { itemOf } = await import("../notes/taskList");
const { useToasts } = await import("../../ui/toast");

const TODAY = "2026-11-22";
const line = (n: number, text: string) => itemOf({ id: `nb:Plan.md:${n}`, kind: "line", notebook: "nb", notebookTitle: "Main", path: "Plan.md", title: "Plan", line: n, done: false, text, sha256: "h1" }, null);
const items = [line(1, "Late (due: 2026-11-01)"), line(2, "This week (owner: Dana, due: 2026-11-24)"), line(3, "No date")];
const milestone: Milestone = { id: "m1", created: 0, updated: 0, project: "pay", title: "Beta", due: "2026-11-23", status: "planned", note: "" };

let root: Root | null = null;
function Page({ onMilestone }: { onMilestone: (m: typeof milestone) => void }) {
  const ticks = useTick();
  return <OpenList sections={homeSections(items, [milestone], TODAY)} today={TODAY} ticks={ticks} onMilestone={onMilestone} empty="Nothing open." />;
}
async function mount(onMilestone = vi.fn()) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Page onMilestone={onMilestone} /></QueryClientProvider>));
  return { el, onMilestone };
}
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; tickTask.mockClear(); useToasts.setState({ items: [] }); });

describe("Home's open list", () => {
  it("shows overdue, this week (milestones flagged) and undated work", async () => {
    const { el } = await mount();
    const heads = [...el.querySelectorAll(".task-group h3")].map((h) => h.textContent);
    expect(heads).toEqual(["Overdue 1", "Today and this week 2", "No due date 1"]);
    const week = el.querySelectorAll(".task-group")[1];
    expect([...week.querySelectorAll("li")].map((li) => li.querySelector(".task-text")?.textContent)).toEqual(["Beta", "This week"]);
    expect(week.querySelector("li svg")).not.toBeNull();
    expect(el.querySelector(".undated-first")?.textContent).toBe("No date");
  });

  it("opens a milestone from its row", async () => {
    const { el, onMilestone } = await mount();
    await act(async () => { el.querySelector<HTMLButtonElement>(".milestone-row button")!.click(); });
    expect(onMilestone).toHaveBeenCalledWith(milestone);
  });

  it("ticks a task, says so with an Undo, and Undo clears the box on the page as it is now", async () => {
    const { el } = await mount();
    const late = el.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => { late.click(); });
    expect(tickTask).toHaveBeenCalledTimes(1);
    expect(tickTask.mock.calls[0]).toEqual([expect.objectContaining({ line: 1, done: false, sha256: "h1" }), true]);
    const toast = useToasts.getState().items[0];
    expect(toast.text).toBe("Done: Late");
    await act(async () => { toast.action!.run(); });
    expect(tickTask).toHaveBeenCalledTimes(2);
    expect(tickTask.mock.calls[1]).toEqual([expect.objectContaining({ line: 1, done: true, sha256: undefined }), false]);
    expect(useToasts.getState().items.length).toBe(1);
  });

  it("shows why a tick was refused", async () => {
    tickTask.mockRejectedValueOnce(new Error("Plan.md changed since it was read"));
    const { el } = await mount();
    await act(async () => { el.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(); });
    expect(useToasts.getState().items[0]).toMatchObject({ kind: "error", text: expect.stringContaining("changed since it was read") });
  });
});
