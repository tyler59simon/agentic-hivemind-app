import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setTransport, type Invoke } from "../lib/lm";
import { detectEol, pageBody, pageText, readFolderPage } from "./pageText";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("no Rust in this test"); }) }));

afterEach(() => setTransport(invoke as Invoke));

const hex = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

function bridge(reply: unknown) {
  const calls: { cmd: string; argv: string[] }[] = [];
  setTransport(async (cmd, args) => {
    calls.push({ cmd, argv: args.argv as string[] });
    return reply && typeof reply === "object" && "exit_code" in reply ? reply : { exit_code: 0, result: reply, error: null };
  });
  return calls;
}
const fail = (code: number, errCode: string, message: string) => ({ exit_code: code, result: null, error: { code: errCode, message } });
const page = async (text: string, extra: object = {}) => ({ domain: "demo", notebook: "nb-1", path: "A.md", text, revision: await hex(text), size: text.length, updated: "2026-11-21T00:00:00Z", truncated: false, ...extra });

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

describe("readFolderPage", () => {
  it("reads by file path and returns the page with its revision as the stamp", async () => {
    const p = await page("# Plan\n");
    const calls = bridge(p);
    const loaded = await readFolderPage("C:/Wiki/A.md");
    expect(loaded).toMatchObject({ text: "# Plan\n", sha256: p.revision, readOnly: null, binary: false, convertible: false });
    expect(calls[0].argv).toEqual(["doc", "read", "--file=C:/Wiki/A.md", "--include-private", "--actor", "viewer"]);
  });

  it("opens read-only when the text is not the page's bytes (Living Memory replaced bad bytes)", async () => {
    bridge({ ...(await page("caf�\n")), revision: "0".repeat(64) });
    expect((await readFolderPage("C:/Wiki/A.md")).readOnly).toMatch(/not UTF-8/);
  });

  it("says a missing page the way the document store recognises a missing file", async () => {
    bridge(fail(2, "invalid", "not_found: no page A.md"));
    await expect(readFolderPage("C:/Wiki/A.md")).rejects.toThrow(/does not exist/);
  });
});
