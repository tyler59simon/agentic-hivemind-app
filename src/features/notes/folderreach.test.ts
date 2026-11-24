// NS-2C, CON-9: the rules behind folder notebooks and Living Memory in Hivemind that need no UI: which domain a folder
// notebook belongs to, the stricter of two reach settings, the watcher route and the proposal merge base. Hosted notebooks
// (pages kept inside the store) were retired by CON-18, so their wrappers and tests are gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { QueryClient } from "@tanstack/react-query";
import {
  decodeBase, docAccept, docAcceptEdited, docProposal, docProposals, docFolderUnset, docReadFile, docReject, domains, proposalAccept, proposalAcceptWith, proposalReject, proposalShow,
  proposalsList, setBridgeGeneration, setTransport, type DocProposal, type DocProposalRow, type DomainInfo, type Invoke,
} from "../../lib/lm";
import { folderPolicyEnabled, useConnection } from "../../lib/connection";
import type { Notebook } from "../../lib/notebooks";
import { pageText } from "../../documents/pageText";
import { useWorkspace } from "../../workspace/store";
import { agentEdits, domainForFolder, notebookForFolder, registerFolder, setFolderReach, stricter } from "./reach";
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
const domain = (name: string, prefixes: string[]) => ({ name, prefixes } as DomainInfo);

describe("the domain of a folder notebook", () => {
  const known = [domain("sandbox", ["C:\\Users\\me\\sandbox"]), domain("app", ["C:/Users/me/sandbox/app"])];

  it("is the bound domain with the longest folder holding it", () => {
    expect(domainForFolder("C:\\Users\\me\\sandbox\\app\\docs", known, "fallback")).toBe("app");
    expect(domainForFolder("c:\\users\\me\\SANDBOX\\notes\\", known, "fallback")).toBe("sandbox");
    expect(domainForFolder("C:\\Users\\me\\sandbox", known, null)).toBe("sandbox");
  });

  it("falls back to Hivemind's default when no bound domain holds the folder", () => {
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

describe("docs-changed", () => {
  it("asks again for the proposals when a folder proposal's file changed, and for the open one", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    onDocsChanged(client, { domain: "demo", notebook: "nb-0123456789", paths: [".folder-proposals/abcdef123456.json"] });
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(['["lm-proposals","*"]', '["lm-proposal"]']);
  });

  it("does nothing for any other path: there is no hosted notebook to follow (CON-18)", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    onDocsChanged(client, { domain: "demo", notebook: "plans", paths: ["A.md", ".proposals/x.json", "assets/p.png", "notebook.json"] });
    expect(spy).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("proposals", () => {
  const proposal = (base: string | null): DocProposal => ({
    id: "p1", domain: "demo", notebook: "nb-0123456789", path: "A.md", base_revision: base, note: null, created: "", status: "pending", body: "theirs", folder: "C:/Wiki",
  } as DocProposal);
  const pageAt = (sha256: string) => ({ sha256, text: "now" }) as never;

  it("are stale when the page moved on or is gone since the agent read it", () => {
    expect(isStale({ proposal: proposal("r1"), page: pageAt("r1") })).toBe(false);
    expect(isStale({ proposal: proposal("r1"), page: pageAt("r2") })).toBe(true);
    expect(isStale({ proposal: proposal("r1"), page: null })).toBe(true);
    expect(isStale({ proposal: proposal(null), page: null })).toBe(false);
    expect(isStale({ proposal: proposal(null), page: pageAt("r9") })).toBe(true);
  });

  it("merge against the page as the agent read it, which the proposal carries, and an empty one for a new page", async () => {
    const seen = answer(() => ({}));
    expect(await baseText({ ...proposal("r1"), base: btoa("as the agent read it") })).toBe("as the agent read it");
    expect(await baseText(proposal(null))).toBe("");
    expect(seen).toEqual([]);   // no history lookup: Living Memory has no page history for a folder page
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
    const row = (folder: string) => ({ folder });
    expect(proposalWhere(row("C:/Users/me/Wiki"), books)).toEqual({ short: "Team wiki", long: "Team wiki" });
    expect(proposalWhere(row("C:/Users/me/Notes/"), books)).toEqual({ short: "Notes", long: "Notes" });
  });

  it("a page is read by its file path, as an option of its own with no operands", async () => {
    const seen = answer(() => ({ origin: "folder", text: "x", revision: "r" }));
    await docReadFile("C:/Users/me/Wiki/-A.md");
    expect(seen).toEqual([["doc", "read", "--file=C:/Users/me/Wiki/-A.md", "--include-private", "--actor", "viewer"]]);
  });
});

describe("Codex re-review of 75ce884", () => {
  it("R2-C1: a doc command without operands has no `--`, which argparse would refuse", async () => {
    const seen = answer(() => ({ ok: true }));
    await docFolderUnset("C:/Wiki");
    await docReadFile("C:/Wiki/A.md");
    expect(seen[0]).toEqual(["doc", "folder", "unset", "--", "C:/Wiki"]);
    expect(seen[1]).toEqual(["doc", "read", "--file=C:/Wiki/A.md", "--include-private", "--actor", "viewer"]);
  });

  it("R2-C2: folder reach needs version 2 of the folder policy, which keeps the fields it is not given", () => {
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, folder_policy: true } } });
    expect(folderPolicyEnabled()).toBe(false);
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, folder_policy: 2 } } });
    expect(folderPolicyEnabled()).toBe(true);
    useConnection.setState({ commands: [], capabilities: undefined });
  });

  it("R2-D1: doc requests carry the bridge generation; other commands do not", async () => {
    const args: Record<string, unknown>[] = [];
    setTransport(async (_cmd, a) => { args.push(a); return { exit_code: 0, result: { domains: [] }, error: null }; });
    setBridgeGeneration(7);
    try {
      await docReadFile("C:/Wiki/A.md");
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
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1 } } });
    expect(folderPolicyEnabled()).toBe(false);
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, folder_policy: 2 } } });
    expect(folderPolicyEnabled()).toBe(true);
    useConnection.setState({ commands: [], capabilities: undefined });
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

  it("U3: Ctrl+N with no folder notebook starts an untitled text file (CON-18: there is no hosted notebook to fall back to)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "notebooks_list" ? [] : null));
    useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1 } } });
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0" });
    const seen = answer(() => ({}));
    await newPageHere(new QueryClient());
    expect(seen).toEqual([]);
    expect(useWorkspace.getState().panes[0].tabs[0]).toMatchObject({ kind: "new-file" });
    vi.mocked(invoke).mockImplementation(async () => null);
    useConnection.setState({ commands: [], capabilities: undefined });
  });
});
