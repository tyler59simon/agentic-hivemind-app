import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OTHER_FOLDERS } from "../../lib/folders";
import { setTransport, type Invoke, type NoteRow, type Project } from "../../lib/lm";
import { groupMemoryNotes, listMemoryNotes } from "./MemoryTree";

const project = (slug: string, name: string): Project => ({
  slug, name, status: "active", tag: `project/${slug}`, tag_registered: true, repos: [], aliases: [],
  description: "", charter: null, created: "", updated: "",
});
const note = (ref: string, title: string, type: string, tags: string[] = []): NoteRow => {
  const [domain, id] = ref.split(":");
  return { ref, domain, id, title, type, tags, status: "active", created: "", updated: "", revision: "r", path: "" };
};

afterEach(() => setTransport(invoke as Invoke));

it("groups by registered project and type across domains, including custom types and duplicate titles", () => {
  const projects = [project("first", "Work"), project("second", "Current")];
  const shared = note("a:1", "Same title", "field-report", ["project/first", "project/second"]);
  const sameTitle = note("b:1", "Same title", "field-report", ["project/first"]);
  const earlierTitle = note("a:2", "Alpha", "field-report", ["project/first"]);
  const plan = note("b:2", "Do the work", "plan", ["project/first"]);
  const unassigned = note("_global:3", "Preferences", "knowledge", ["project/missing"]);
  const rows = [sameTitle, shared, plan, earlierTitle, unassigned];
  expect(groupMemoryNotes(rows, projects, null)).toEqual([
    { slug: "second", name: "Current", types: [{ type: "field-report", notes: [shared] }] },
    { slug: null, name: "Unassigned", types: [{ type: "knowledge", notes: [unassigned] }] },
    { slug: "first", name: "Work", types: [{ type: "field-report", notes: [earlierTitle, shared, sameTitle] }, { type: "plan", notes: [plan] }] },
  ]);
  expect(groupMemoryNotes(rows, projects, "second").map((g) => g.slug)).toEqual(["second"]);
  expect(groupMemoryNotes(rows, projects, OTHER_FOLDERS).map((g) => g.slug)).toEqual([null]);
  expect(groupMemoryNotes(rows, projects, "missing")).toEqual([]);
});

it("lists every page of active note metadata and coalesces refs repeated across pages", async () => {
  const rows = Array.from({ length: 251 }, (_, i) => note(`a:${i}`, `Note ${i}`, "knowledge"));
  const requests: string[][] = [];
  setTransport(vi.fn(async (_cmd, args) => {
    const argv = args.argv as string[];
    requests.push(argv);
    const offset = argv.includes("--offset") ? Number(argv[argv.indexOf("--offset") + 1]) : 0;
    const notes = offset ? [rows[249], rows[250]] : rows.slice(0, 250);
    return { exit_code: 0, result: { offset, notes, domains: ["a"], total: 252 }, error: null };
  }));

  expect(await listMemoryNotes(new AbortController().signal)).toEqual(rows);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(expect.arrayContaining(["search", "--all-domains", "--status", "active", "--limit", "250"]));
  expect(requests[1]).toEqual(expect.arrayContaining(["--offset", "250"]));
});
