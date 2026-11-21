// NS-2C: the rules behind Living Memory notebooks in Hivemind that need no UI: which domain a folder notebook belongs
// to, the stricter of two reach settings, the notebook list grouped by domain, ids from titles, the memory-domain
// filter, the watcher route and the proposal merge base.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { QueryClient } from "@tanstack/react-query";
import { domains, setTransport, type DocProposal, type DomainInfo, type Invoke } from "../../lib/lm";
import { domainForFolder, stricter } from "./reach";
import { notebookId } from "./NewNotebook";
import { baseText, isStale } from "./ProposalInbox";
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
    expect(keys).toEqual(expect.arrayContaining(['["notebook-tree","lm:demo:plans"]', '["lm-notebooks"]', '["lm-proposals","demo","plans"]']));
    expect(refresh).toHaveBeenCalledWith("lm:demo:plans", ["A.md", "S/B.MD"]);
  });

  it("leaves the notebook list alone for page edits", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    onDocsChanged(client, { domain: "demo", notebook: "plans", paths: ["A.md"] });
    expect(spy.mock.calls.map(([f]) => (f as { queryKey: string[] }).queryKey[0])).toEqual(["notebook-tree"]);
  });
});

describe("proposals", () => {
  const proposal = (base: string | null): DocProposal => ({
    id: "p1", domain: "demo", notebook: "plans", path: "A.md", base_revision: base, note: null, created: "", status: "pending", body: "theirs",
  } as DocProposal);
  const pageAt = (revision: string) => ({ revision, text: "now" }) as never;

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
    expect(seen[1]).toEqual(["doc", "history", "demo", "plans", "A.md", "--version", "op1", "--include-private", "--actor", "viewer"]);
  });

  it("have no base once retention removed it, and an empty one for a new page", async () => {
    answer(() => ({ history: [{ operation_id: "op2", after_revision: "r2" }] }));
    expect(await baseText(proposal("r1"))).toBeNull();
    expect(await baseText(proposal(null))).toBe("");
  });
});
