import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setTransport, type Invoke } from "../../lib/lm";
import { assetLink, deletePage, detectEol, lmContainer, pageBody, pageText, pageTree, parseLm, readPage, savePage } from "./lmdoc";
import { createDoc, createSection, readDoc } from "../io";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("no Rust in this test"); }) }));

afterEach(() => setTransport(invoke as Invoke));

const hex = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

/** A fake bridge: `replies` answers by the command's first words; every call is kept. */
function bridge(replies: (cmd: string, argv: string[], body?: string) => unknown) {
  const calls: { cmd: string; argv: string[]; body?: string }[] = [];
  setTransport(async (cmd, args) => {
    const argv = args.argv as string[];
    const body = (args.body ?? args.stdin ?? undefined) as string | undefined;
    calls.push({ cmd, argv, body });
    const r = await replies(cmd, argv, body);
    return r && typeof r === "object" && "exit_code" in r ? r : { exit_code: 0, result: r, error: null };
  });
  return calls;
}
const fail = (code: number, errCode: string, message: string) => ({ exit_code: code, result: null, error: { code: errCode, message } });
const page = async (text: string, extra: object = {}) => ({ domain: "demo", notebook: "plans", path: "A.md", text, revision: await hex(text), size: text.length, updated: "2026-11-21T00:00:00Z", truncated: false, ...extra });
const where = { domain: "demo", notebook: "plans" };

describe("container ids", () => {
  it("name a domain and a notebook", () => {
    expect(lmContainer("demo", "plans")).toBe("lm:demo:plans");
    expect(parseLm("lm:demo:plans")).toEqual(where);
    for (const bad of ["nb-1234", "@abc", "lm:", "lm:demo", "lm::plans", "lm:demo:"]) expect(parseLm(bad)).toBeNull();
  });
});

describe("page format", () => {
  it("follows the Rust file service's line-ending rules", () => {
    expect(detectEol("a\nb")).toBe("lf");
    expect(detectEol("a\r\nb\r\n")).toBe("crlf");
    expect(detectEol("a\rb")).toBe("cr");
    expect(detectEol("abc")).toBe("none");
    expect(detectEol("a\r\nb\n")).toBe("mixed");
  });

  it("gives the editor LF text and writes the page's own endings and byte order mark back", () => {
    const raw = "﻿# T\r\nbody\r\n";
    const { text, format, readOnly } = pageText(raw);
    expect(text).toBe("# T\nbody\n");
    expect(format).toMatchObject({ bom: true, eol: "crlf", encoding: "UTF-8" });
    expect(readOnly).toBeNull();
    expect(pageBody(text, format)).toBe(raw);
    expect(pageBody("# T\nnew\n", format)).toBe("﻿# T\r\nnew\r\n");
  });

  it("opens a page with mixed line endings read-only and never saves it", () => {
    const { format, readOnly } = pageText("a\r\nb\n");
    expect(readOnly).toMatch(/mixes line-ending styles/);
    expect(() => pageBody("a\nb\n", format)).toThrow(/mixes/);
  });
});

describe("reading", () => {
  it("returns the page with its revision as the stamp", async () => {
    const p = await page("# Plan\n");
    const calls = bridge(() => p);
    const loaded = await readPage(where, "A.md");
    expect(loaded).toMatchObject({ text: "# Plan\n", sha256: p.revision, readOnly: null, binary: false, convertible: false });
    expect(calls[0].argv).toEqual(["doc", "read", "--include-private", "--actor", "viewer", "--", "demo", "plans", "A.md"]);
  });

  it("opens read-only when the text is not the page's bytes (Living Memory replaced bad bytes)", async () => {
    bridge(async () => ({ ...(await page("caf�\n")), revision: "0".repeat(64) }));
    expect((await readPage(where, "A.md")).readOnly).toMatch(/not UTF-8/);
  });

  it("says a missing page the way the document store recognises a missing file", async () => {
    bridge(() => fail(2, "invalid", "not_found: no page A.md"));
    await expect(readPage(where, "A.md")).rejects.toThrow(/does not exist/);
  });

  it("io dispatches Living Memory containers to the doc commands", async () => {
    const calls = bridge(async () => page("x\n"));
    await readDoc({ notebook: "lm:demo:plans", path: "A.md" });
    expect(calls[0].cmd).toBe("lm");
    expect(calls[0].argv.slice(0, 2)).toEqual(["doc", "read"]);
  });
});

describe("saving", () => {
  const format = pageText("a\n").format;

  it("writes against the revision it read, with the body through lm_body", async () => {
    const calls = bridge(() => ({ revision: "r2" }));
    const outcome = await savePage(where, "A.md", "new\n", { sha256: "r1", size: 2, mtimeMs: 0 }, format);
    expect(outcome).toMatchObject({ status: "saved", sha256: "r2" });
    expect(calls[0]).toMatchObject({ cmd: "lm_body", body: "new\n" });
    expect(calls[0].argv).toEqual(["doc", "write", "--expected-revision", "r1", "--include-private", "--", "demo", "plans", "A.md"]);
  });

  it("reports a stale revision and a page that is gone", async () => {
    bridge(() => fail(6, "stale", "Stale revision"));
    expect(await savePage(where, "A.md", "x", { sha256: "r1", size: 1, mtimeMs: 0 }, format)).toEqual({ status: "stale", sha256: "" });
    bridge(() => fail(2, "invalid", "not_found: no page A.md"));
    expect(await savePage(where, "A.md", "x", { sha256: "r1", size: 1, mtimeMs: 0 }, format)).toEqual({ status: "gone" });
  });

  it("deletes against the revision it reads when the page is not open", async () => {
    const p = await page("x\n");
    const calls = bridge((_cmd, argv) => (argv[1] === "read" ? p : {}));
    await deletePage(where, "A.md");
    expect(calls[1].argv).toEqual(["doc", "delete", "--expected-revision", p.revision, "--include-private", "--", "demo", "plans", "A.md"]);
  });
});

describe("tree and sections", () => {
  it("maps folders to sections and pages to pages", async () => {
    bridge(() => ({ title: "Plans", entries: [{ path: "S", kind: "folder" }, { path: "S/P.md", kind: "page", size: 3, updated: "2026-11-21T00:00:00Z" }] }));
    const tree = await pageTree(where);
    expect(tree.entries.map((e) => [e.path, e.kind])).toEqual([["S", "dir"], ["S/P.md", "page"]]);
  });

  it("creates a Living Memory section with its first page", async () => {
    const calls = bridge(() => ({ revision: "r" }));
    expect(await createSection("lm:demo:plans", "Ideas")).toBe("Ideas/Untitled.md");
    expect(calls[0].argv).toEqual(["doc", "create", "--include-private", "--", "demo", "plans", "Ideas/Untitled.md"]);
  });

  it("D5 (review of 32fee20): creates a gone page again with the format it had", async () => {
    const calls = bridge(() => ({ revision: "r" }));
    await createDoc("lm:demo:plans", "A.md", "a\nb\n", pageText("\uFEFFx\r\n").format);
    expect(calls[0].body).toBe("\uFEFFa\r\nb\r\n");
  });
});

describe("attachment links", () => {
  it("are relative to the page and encoded", () => {
    expect(assetLink("A.md", "assets/1234abcd-my pic.png")).toBe("assets/1234abcd-my%20pic.png");
    expect(assetLink("S/T/A.md", "assets/x.pdf")).toBe("../../assets/x.pdf");
  });
});
