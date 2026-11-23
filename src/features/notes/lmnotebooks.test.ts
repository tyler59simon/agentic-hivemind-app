// NS-2C: the rules behind Living Memory notebooks in Hivemind that need no UI: which domain a folder notebook belongs
// to, the stricter of two reach settings, the notebook list grouped by domain, ids from titles, the memory-domain
// filter, the watcher route and the proposal merge base.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { QueryClient } from "@tanstack/react-query";
import {
  decodeBase, docAccept, docAcceptEdited, docNotebooks, docProposal, docProposals, docReadFile, docReject, domains, proposalAccept, proposalAcceptWith, proposalReject, proposalShow,
  proposalsList, setBridgeGeneration, setTransport, type DocProposal, type DocProposalRow, type DomainInfo, type Invoke,
} from "../../lib/lm";
import { folderPolicyEnabled, useConnection } from "../../lib/connection";
import type { Notebook } from "../../lib/notebooks";
import { pageText, parseLm } from "../../documents/adapters/lmdoc";
import { useWorkspace } from "../../workspace/store";
import { agentEdits, domainForFolder, notebookForFolder, registerFolder, setFolderReach, stricter } from "./reach";
import { notebookId } from "./NewNotebook";
import { baseText, isStale, mergedBody, proposalWhere, unmergeable } from "./ProposalInbox";
import { newPageHere } from "./actions";
import { onDocsChanged } from "../../documents/sync";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../documents/store", async (orig) => ({ ...(await orig<object>()), refresh }));

afterEach(() => setTransport(invoke as Invoke));
const answer = (fn: (argv: string[]) => unknown) => {
  const seen: string[][] = [];
  setTransport(async (_cmd, a) => { seen.push(a.argv as string[]); return { exit_code: 0, result: fn(a.argv as string[]), error: null }; });
  return seen;
};
const domain = (name: string, prefixes: string[], kind: DomainInfo["kind"] = "memory") => ({ name, prefixes, kind } as DomainInfo);

describe("the domain of a folder notebook", () => {
  const known = [domain("sandbox", ["C:\\Users\\me\\sandbox"]), domain("app", ["C:/Users/me/sandbox/app"]), domain("jot", ["C:\\Users\\me\\jot"], "notebook")];

  it("is the bound domain with the longest folder holding it", () => {
    expect(domainForFolder("C:\\Users\\me\\sandbox\\app\\docs", known, "fallback")).toBe("app");
    expect(domainForFolder("c:\\users\\me\\SANDBOX\\notes\\", known, "fallback")).toBe("sandbox");
    expect(domainForFolder("C:\\Users\\me\\sandbox", known, null)).toBe("sandbox");
  });

  it("is never a notebook-only domain, and falls back to Hivemind's default", () => {
    expect(domainForFolder("C:\\Users\\me\\jot\\daily", known, "fallback")).toBe("fallback");
    expect(domainForFolder("C:\\Users\\me\\sandboxed", known, null)).toBeNull();
  });
});

describe("stricter reach", () => {
  it("orders private, hidden, searchable, injectable", () => {
    expect(stricter({ visibility: "injectable" }, { visibility: "searchable" })).toEqual({ visibility: "searchable", private: false });
    expect(stricter({ visibility: "searchable" }, { visibility: "hidden" })).toEqual({ visibility: "hidden", private: false });
    expect(stricter({}, {})).toEqual({ visibility: "searchable", private: false });
    expect(stricter({ private: true }, { visibility: "injectable" })).toEqual({ visibility: "injectable", private: true });
  });

  it("counts a value it does not know as hidden", () => {
    expect(stricter({ visibility: "public" as never }, { visibility: "injectable" }).visibility).toBe("hidden");
  });
});

describe("notebook ids from titles", () => {
  it("are lowercase letters, digits and hyphens, 2 to 40 long", () => {
    expect(notebookId("Plans")).toBe("plans");
    expect(notebookId("  Café notes: 2026! ")).toBe("cafe-notes-2026");
    expect(notebookId("x")).toBe("notebook");
    expect(notebookId("a".repeat(39) + " b")).toBe("a".repeat(39));
    expect(notebookId("日本")).toBe("notebook");
  });
});

describe("memory domain pickers", () => {
  it("leave out notebook-only domains", async () => {
    answer(() => ({ domains: [domain("sandbox", ["C:\\x"]), domain("jot", [], "notebook"), { name: "old", prefixes: [] }] }));
    expect((await domains()).domains.map((d) => d.name)).toEqual(["sandbox", "old"]);
  });
});

describe("docs-changed", () => {
  it("refreshes the tree, open pages, and the notebook list and proposals when their files changed", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    onDocsChanged(client, { domain: "demo", notebook: "plans", paths: ["A.md", "S/B.MD", ".proposals/x.json", "assets/p.png", "notebook.json"] });
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["notebook-tree","lm:demo:plans"]', '["lm-notebooks"]', '["lm-proposals","demo","plans"]', '["lm-assets","lm:demo:plans"]']));
    expect(refresh).toHaveBeenCalledWith("lm:demo:plans", ["A.md", "S/B.MD"]);
  });

  it("leaves the notebook list alone for page edits, and asks again for the proposal open in the inbox (U1)", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    onDocsChanged(client, { domain: "demo", notebook: "plans", paths: ["A.md"] });
    expect(spy.mock.calls.map(([f]) => (f as { queryKey: string[] }).queryKey[0])).toEqual(["notebook-tree", "lm-proposal"]);
    spy.mockClear();
    onDocsChanged(client, { domain: "demo", notebook: "plans", paths: ["assets/p.png"] });
    expect(spy.mock.calls.map(([f]) => (f as { queryKey: string[] }).queryKey[0])).toEqual(["notebook-tree", "lm-assets"]);
  });
});

describe("proposals", () => {
  const proposal = (base: string | null): DocProposal => ({
    id: "p1", domain: "demo", notebook: "plans", path: "A.md", base_revision: base, note: null, created: "", status: "pending", body: "theirs",
  } as DocProposal);
  const pageAt = (sha256: string) => ({ sha256, text: "now" }) as never;

  it("are stale when the page moved on or is gone since the agent read it", () => {
    expect(isStale({ proposal: proposal("r1"), page: pageAt("r1") })).toBe(false);
    expect(isStale({ proposal: proposal("r1"), page: pageAt("r2") })).toBe(true);
    expect(isStale({ proposal: proposal("r1"), page: null })).toBe(true);
    expect(isStale({ proposal: proposal(null), page: null })).toBe(false);
    expect(isStale({ proposal: proposal(null), page: pageAt("r9") })).toBe(true);
  });

  it("merge against the version the agent read, found through the operation that wrote it", async () => {
    const seen = answer((argv) => argv.includes("--version")
      ? { text: "as the agent read it", revision: "r1" }
      : { history: [{ operation_id: "op2", after_revision: "r2" }, { operation_id: "op1", after_revision: "r1" }] });
    expect(await baseText(proposal("r1"))).toBe("as the agent read it");
    expect(seen[1]).toEqual(["doc", "history", "--version", "op1", "--include-private", "--actor", "viewer", "--", "demo", "plans", "A.md"]);
  });

  it("have no base once retention removed it, and an empty one for a new page", async () => {
    answer(() => ({ history: [{ operation_id: "op2", after_revision: "r2" }] }));
    expect(await baseText(proposal("r1"))).toBeNull();
    expect(await baseText(proposal(null))).toBe("");
  });
});

describe("one proposals command (CON-25)", () => {
  it("every proposal wrapper runs `proposals`, a note's with its kind and a page edit's with --include-private", async () => {
    const seen = answer(() => ({ proposals: [], proposal: {} }));
    await proposalsList();
    await proposalShow("abcd1234");
    await proposalAccept("abcd1234");
    await proposalAcceptWith("abcd1234", { title: "T", body: "B", type: "decision" }, "architecture");
    await proposalReject("abcd1234", "known");
    await proposalReject("abcd1235");
    await docProposals();
    await docProposals("demo", "plans");
    await docProposal("0123456789ab");
    await docAccept("0123456789ab");
    await docReject("0123456789ab");
    expect(seen).toEqual([
      ["proposals", "list", "--kind", "note", "--actor", "viewer"],
      ["proposals", "show", "abcd1234", "--actor", "viewer"],
      ["proposals", "accept", "abcd1234"],
      ["capture", "--from-proposal", "abcd1234", "--type", "decision", "--concern", "architecture", "T", "B"],
      ["proposals", "reject", "abcd1234", "--reason", "known"],
      ["proposals", "reject", "abcd1235"],
      ["proposals", "list", "--kind", "page", "--include-private", "--actor", "viewer"],
      ["proposals", "list", "--kind", "page", "--domain", "demo", "--notebook=plans", "--include-private", "--actor", "viewer"],
      ["proposals", "show", "0123456789ab", "--include-private", "--actor", "viewer"],
      ["proposals", "accept", "0123456789ab", "--include-private"],
      ["proposals", "reject", "0123456789ab", "--include-private"],
    ]);
  });

  it("a note's show reply is unwrapped from {kind, proposal}", async () => {
    answer(() => ({ ok: true, kind: "note", proposal: { id: "abcd1234", status: "pending", note: { title: "T", body: "B" } } }));
    expect((await proposalShow("abcd1234")).note.title).toBe("T");
  });

  it("proposals writes carry the bridge generation, like doc writes", async () => {
    const args: Record<string, unknown>[] = [];
    setTransport(async (_cmd, a) => { args.push(a); return { exit_code: 0, result: {}, error: null }; });
    setBridgeGeneration(4);
    try { await docAccept("0123456789ab"); } finally { setBridgeGeneration(undefined); }
    expect(args[0].generation).toBe(4);
  });
});

describe("folder proposals (CON-9)", () => {
  const folder = (base: string | null | undefined, baseRevision: string | null = "r1"): DocProposal => ({
    id: "0123456789ab", domain: "demo", notebook: "nb-0123456789", path: "A.md", base_revision: baseRevision, note: null, created: "", status: "pending",
    body: "theirs", folder: "C:/Users/me/Wiki", base,
  } as DocProposal);
  const bytes = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

  it("the merge base is the page as the agent read it, decoded with its byte order mark and line endings", async () => {
    const seen = answer(() => ({}));
    expect(await baseText(folder(bytes("\uFEFFone\r\ntwo\r\n")))).toBe("\uFEFFone\r\ntwo\r\n");
    expect(pageText((await baseText(folder(bytes("\uFEFFone\r\ntwo\r\n"))))!).text).toBe("one\ntwo\n");
    expect(decodeBase(bytes("caf\u00e9"))).toBe("caf\u00e9");
    expect(seen).toEqual([]);   // no history lookup: the proposal carries its base
  });

  it("have no base when none was kept (a page over 1 MiB) and an empty one for a new page", async () => {
    answer(() => ({}));
    expect(await baseText(folder(null))).toBeNull();
    expect(await baseText(folder(undefined))).toBeNull();
    expect(await baseText(folder(null, null))).toBe("");
  });

  it("a folder is matched to Hivemind's notebook ignoring case and the kind of slash", () => {
    const books = [{ id: "nb-1", path: "C:\\Users\\me\\Wiki", title: "Wiki" }, { id: "nb-2", path: "D:\\Other", title: "Other" }];
    expect(notebookForFolder(books, "c:/users/me/wiki")?.id).toBe("nb-1");
    expect(notebookForFolder(books, "C:/Users/me/Wiki/")?.id).toBe("nb-1");
    expect(notebookForFolder(books, "C:/Users/me/Wiki2")).toBeNull();
    expect(notebookForFolder(books, null)).toBeNull();
  });

  it("a folder notebook counts its pending page edits", () => {
    const row = (folder: string | undefined, status: DocProposalRow["status"] = "pending") => ({ id: "x", folder, status }) as DocProposalRow;
    const rows = [row("C:/Users/me/Wiki"), row("c:/users/me/wiki"), row("C:/Users/me/Wiki", "accepted"), row("D:/Other"), row(undefined)];
    expect(agentEdits(rows, { path: "C:\\Users\\me\\Wiki" })).toBe(2);
    expect(agentEdits(rows, { path: "E:\\Nothing" })).toBe(0);
  });

  it("the Inbox names a folder page's notebook by its title, else by the folder, never by the nb- id", () => {
    const books = [{ path: "C:\\Users\\me\\Wiki", title: "Team wiki" }];
    const row = (folderPath?: string) => ({ domain: "demo", notebook: folderPath ? "nb-0123456789" : "plans", folder: folderPath });
    expect(proposalWhere(row("C:/Users/me/Wiki"), books)).toEqual({ short: "Team wiki", long: "Team wiki" });
    expect(proposalWhere(row("C:/Users/me/Notes/"), books)).toEqual({ short: "Notes", long: "Notes" });
    expect(proposalWhere(row(), books)).toEqual({ short: "plans", long: "demo / plans" });
  });

  it("a page is read by its file path, as an option of its own with no operands", async () => {
    const seen = answer(() => ({ origin: "folder", text: "x", revision: "r" }));
    await docReadFile("C:/Users/me/Wiki/-A.md");
    expect(seen).toEqual([["doc", "read", "--file=C:/Users/me/Wiki/-A.md", "--include-private", "--actor", "viewer"]]);
  });
});

describe("Codex re-review of 75ce884", () => {
  it("R2-C1: a doc command without operands has no `--`, which argparse would refuse", async () => {
    const seen = answer(() => ({ notebooks: [] }));
    await docNotebooks();
    expect(seen[0]).toEqual(["doc", "notebooks", "--all-domains", "--include-hidden", "--include-private", "--actor", "viewer"]);
  });

  it("R2-C2: folder reach needs version 2 of the folder policy, which keeps the fields it is not given", () => {
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1, folder_policy: true } } });
    expect(folderPolicyEnabled()).toBe(false);
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1, folder_policy: 2 } } });
    expect(folderPolicyEnabled()).toBe(true);
    useConnection.setState({ commands: [], capabilities: undefined });
  });

  it("R2-D1: doc requests carry the bridge generation; other commands do not", async () => {
    const args: Record<string, unknown>[] = [];
    setTransport(async (_cmd, a) => { args.push(a); return { exit_code: 0, result: { notebooks: [], domains: [] }, error: null }; });
    setBridgeGeneration(7);
    try {
      await docNotebooks();
      await domains();
    } finally {
      setBridgeGeneration(undefined);
    }
    expect(args[0].generation).toBe(7);
    expect(args[1]).not.toHaveProperty("generation");
  });
});

describe("Codex review of 32fee20", () => {
  const nb: Notebook = { id: "nb-1", path: "C:\\Users\\me\\sandbox\\notes", title: "Notes", added: "" };
  const invoked = () => vi.mocked(invoke).mock.calls.map(([cmd, args]) => [cmd, args] as [string, Record<string, unknown>]);
  const folderReply = (argv: string[]) => argv[0] === "domains"
    ? { domains: [domain("sandbox", ["C:\\Users\\me\\sandbox"])] }
    : { folder: { domain: "sandbox", visibility: "hidden", private: true } };
  afterEach(() => vi.mocked(invoke).mockClear());

  it("P1: registering a folder names no visibility or private flag and leaves its sidecar alone", async () => {
    const seen = answer(folderReply);
    const policy = await registerFolder(nb, null);
    expect(seen[1]).toEqual(["doc", "folder", "set", "--domain", "sandbox", "--", nb.path]);
    expect(policy).toEqual({ domain: "sandbox", visibility: "hidden", private: true });
    expect(invoked().map(([cmd]) => cmd)).toEqual(["notebook_reach_record"]);
  });

  it("P3: a reach change sends and records only the fields the user changed", async () => {
    const seen = answer(folderReply);
    await setFolderReach(nb, "sandbox", { visibility: "hidden" });
    expect(seen[0]).toEqual(["doc", "folder", "set", "--domain", "sandbox", "--visibility", "hidden", "--", nb.path]);
    expect(invoked()[0]).toEqual(["notebook_meta_set", { id: "nb-1", patch: { visibility: "hidden" } }]);
    vi.mocked(invoke).mockClear();
    await setFolderReach(nb, "sandbox", { private: false });
    expect(seen[1]).toEqual(["doc", "folder", "set", "--domain", "sandbox", "--no-private", "--", nb.path]);
    expect(invoked()[0]).toEqual(["notebook_meta_set", { id: "nb-1", patch: { private: true } }]);
  });

  it("C1: folder reach needs Living Memory's folder policy, not only notebook pages", () => {
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1 } } });
    expect(folderPolicyEnabled()).toBe(false);
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1, folder_policy: 2 } } });
    expect(folderPolicyEnabled()).toBe(true);
    useConnection.setState({ commands: [], capabilities: undefined });
  });

  it("C2: a damaged notebook is listed apart, so the healthy ones still sort", async () => {
    answer(() => ({ notebooks: [
      { domain: "demo", notebook: "b", title: "B" }, { domain: "demo", notebook: "x", error: "notebook.json is damaged" }, { domain: "demo", notebook: "a", title: "A" },
    ] }));
    const listed = await docNotebooks();
    expect(listed.notebooks.map((n) => n.notebook)).toEqual(["b", "a"]);
    expect(listed.damaged).toEqual([{ domain: "demo", notebook: "x", error: "notebook.json is damaged" }]);
  });

  it("C3: container ids follow Living Memory's names", () => {
    expect(parseLm(`lm:${"d".repeat(121)}:plans`)).not.toBeNull();
    for (const bad of ["lm:-demo:plans", "lm:demo:-plans", "lm:demo:Plans", "lm:demo:a", "lm:.x:plans", "lm:demo:p_q"]) expect(parseLm(bad), bad).toBeNull();
  });

  it("C4: options go before `--` and free text is joined to its option", async () => {
    const seen = answer(() => ({}));
    await docReject("p1", "-not an option");
    await docAcceptEdited("p1", "merged\r\n", "r2");
    await docAcceptEdited("p2", "new page", null);
    expect(seen).toEqual([
      ["proposals", "reject", "p1", "--reason=-not an option", "--include-private"],
      ["proposals", "accept", "p1", "--edited", "--expected-revision", "r2", "--include-private"],
      ["proposals", "accept", "p2", "--edited", "--include-private"],
    ]);
  });

  it("D2: a page or proposal a merge cannot write unchanged is not merged", () => {
    const page = (readOnly: string | null) => ({ text: "x\n", format: pageText("x\n").format, readOnly }) as never;
    expect(unmergeable({ page: page("This page holds bytes that are not UTF-8"), proposed: pageText("y\n") })).toMatch(/not UTF-8/);
    expect(unmergeable({ page: null, proposed: pageText("a\r\nb\n") })).toMatch(/mixes line-ending/);
    expect(unmergeable({ page: page(null), proposed: pageText("y\n") })).toBeNull();
  });

  it("D5: a merge keeps the page's format, and a new page the proposal's", () => {
    const crlf = { text: "x\n", format: pageText("x\r\n").format, readOnly: null } as never;
    expect(mergedBody("a\nb\n", { page: crlf, proposed: pageText("a\n") })).toBe("a\r\nb\r\n");
    expect(mergedBody("a\nb\n", { page: null, proposed: pageText("\uFEFFa\r\n") })).toBe("\uFEFFa\r\nb\r\n");
  });

  it("U3: Ctrl+N with only Living Memory notebooks makes a page in the first one", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "notebooks_list" ? [] : null));
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1 } } });
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0" });
    const seen = answer((argv) => (argv[1] === "notebooks"
      ? { notebooks: [{ domain: "zeta", notebook: "z1", title: "Z" }, { domain: "demo", notebook: "plans", title: "Plans" }] }
      : { revision: "r1" }));
    await newPageHere(new QueryClient());
    expect(seen[1]).toEqual(["doc", "create", "--include-private", "--", "demo", "plans", "Untitled.md"]);
    expect(useWorkspace.getState().panes[0].tabs[0].file).toEqual({ notebook: "lm:demo:plans", path: "Untitled.md" });
    vi.mocked(invoke).mockImplementation(async () => null);
    useConnection.setState({ commands: [], capabilities: undefined });
  });
});
