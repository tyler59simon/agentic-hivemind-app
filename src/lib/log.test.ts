// @vitest-environment jsdom
// What the webview tells the log: fixed kinds, identifiers, numbers and the app's own source locations, never text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock("@tauri-apps/api/core", () => core);

const { componentsOf, framesOf, ident, installGlobalLogging, logLmFailure, logRejection, logRenderError, logWindowError } = await import("./log");

const MARKER = "SECRET-MARKER-1";
const inApp = (on: boolean) => {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};
/** The events sent to `log_client`. */
const sent = () => core.invoke.mock.calls.filter((c) => c[0] === "log_client").map((c) => (c[1] as { event: Record<string, unknown> }).event);

beforeEach(() => { core.invoke.mockClear(); core.invoke.mockImplementation(async () => undefined); });
afterEach(() => inApp(false));

/** An error whose stack has a header with the marker and frames in and out of this app's bundle. */
function marked(): Error {
  const e = new Error(`${MARKER} in a page about private things`);
  e.stack = [
    `Error: ${MARKER} in a page about private things`,
    `    at doThing (http://tauri.localhost/assets/index-abc123.js:10:20)`,
    `    at https://evil.example/assets/${MARKER}.js:1:1`,
    `    at file:///C:/Users/someone/${MARKER}/x.js:3:4`,
    `    at http://tauri.localhost/assets/vendor.js?v=${MARKER}#frag:30:40`,
    `    at http://localhost:1420/node_modules/.vite/deps/x.js:5:6`,
    `    at render@tauri://localhost/assets/index-abc123.js:7:8`,
  ].join("\n");
  return e;
}

describe("ident", () => {
  it("accepts plain identifiers only", () => {
    expect(ident("TypeError")).toBe("TypeError");
    expect(ident("stale_revision")).toBe("stale_revision");
    for (const bad of ["", "9lives", "a-b", "has space", MARKER, "x".repeat(42), 5, null, undefined, {}]) expect(ident(bad)).toBeUndefined();
  });
});

describe("source locations and component names", () => {
  it("keeps only the path, line and column of this app's own files", () => {
    expect(framesOf(marked().stack)).toEqual([
      { file: "/assets/index-abc123.js", line: 10, column: 20 },
      { file: "/assets/vendor.js", line: 30, column: 40 },
      { file: "/assets/index-abc123.js", line: 7, column: 8 },
    ]);
  });

  it("keeps at most eight frames and no text from a stack that is not one", () => {
    const stack = Array.from({ length: 20 }, (_, i) => `    at f (http://tauri.localhost/assets/a.js:${i + 1}:1)`).join("\n");
    expect(framesOf(stack)).toHaveLength(8);
    expect(framesOf(MARKER)).toEqual([]);
    expect(framesOf(undefined)).toEqual([]);
    expect(framesOf({ stack: MARKER })).toEqual([]);
  });

  it("reduces a component stack to component names", () => {
    const stack = `\n    at Bomb (http://tauri.localhost/assets/a.js:1:1)\n    at ErrorBoundary (http://x/y.js:2:2)\n    at ${MARKER} here\n    at div\nBomb2@http://x/y.js:3:3`;
    expect(componentsOf(stack)).toEqual(["Bomb", "ErrorBoundary", "div", "Bomb2"]);
    expect(componentsOf(Array.from({ length: 30 }, (_, i) => `    at C${i} (x)`).join("\n"))).toHaveLength(12);
  });
});

describe("events", () => {
  beforeEach(() => inApp(true));

  it("sends a render error with the error's name, its source locations and component names, and none of its text", () => {
    logRenderError(marked(), `\n    at Bomb (http://tauri.localhost/assets/a.js:1:1)\n    at ErrorBoundary (http://x/y.js:2:2)`);
    expect(sent()).toEqual([{
      kind: "render_error", name: "Error", component: ["Bomb", "ErrorBoundary"],
      frames: [{ file: "/assets/index-abc123.js", line: 10, column: 20 }, { file: "/assets/vendor.js", line: 30, column: 40 }, { file: "/assets/index-abc123.js", line: 7, column: 8 }],
    }]);
    expect(JSON.stringify(sent())).not.toContain(MARKER);
  });

  it("sends an uncaught error with its place, and a rejection with no text from its reason", () => {
    logWindowError(new ErrorEvent("error", { message: MARKER, filename: "http://tauri.localhost/assets/index-abc.js?x=1#h", lineno: 12, colno: 5, error: `${MARKER} thrown as a string` }));
    logRejection(`${MARKER} as a reason`);
    logRejection(marked());
    expect(sent()[0]).toEqual({ kind: "window_error", frames: [{ file: "/assets/index-abc.js", line: 12, column: 5 }] });
    expect(sent()[1]).toEqual({ kind: "unhandled_rejection" });
    expect(sent()[2]).toMatchObject({ kind: "unhandled_rejection", name: "Error" });
    expect(JSON.stringify(sent())).not.toContain(MARKER);
  });

  it("names an error whose name is not an identifier as other", () => {
    const e = new Error("x");
    e.name = `${MARKER} is my name`;
    logRejection(e);
    expect(sent()).toEqual([{ kind: "unhandled_rejection", name: "other", frames: framesOf(e.stack) }]);
  });

  it("sends a failed command's name, code and exit status", () => {
    logLmFailure("read", "stale_revision", 6);
    logLmFailure(`doc ${MARKER}`, MARKER, `${MARKER}`);
    logLmFailure(undefined, undefined, -1);
    expect(sent()).toEqual([
      { kind: "lm_failure", name: "read", code: "stale_revision", exit: 6 },
      { kind: "lm_failure", name: "other", code: "other" },
      { kind: "lm_failure", name: "other", code: "other" },
    ]);
  });

  it("is installed on the window, and logs its errors and unhandled rejections", () => {
    installGlobalLogging();
    window.dispatchEvent(new ErrorEvent("error", { message: MARKER, filename: "http://tauri.localhost/assets/x.js", lineno: 1, colno: 2, error: marked() }));
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: marked() });
    window.dispatchEvent(rejection);
    expect(sent().map((e) => e.kind)).toEqual(["window_error", "unhandled_rejection"]);
    expect(JSON.stringify(sent())).not.toContain(MARKER);
  });
});

describe("a thrown value of any kind", () => {
  const odd: [string, unknown][] = [
    ["a string", MARKER],
    ["null", null],
    ["undefined", undefined],
    ["a symbol", Symbol(MARKER)],
    ["an object without toString", Object.create(null)],
    ["an object whose toString throws", { toString() { throw new Error("no"); } }],
    ["an error whose name getter throws", Object.defineProperty(new Error(MARKER), "name", { get() { throw new Error("no"); } })],
    ["an error whose stack getter throws", Object.defineProperty(new Error(MARKER), "stack", { get() { throw new Error("no"); } })],
    ["a proxy that throws on every read", new Proxy({}, { get() { throw new Error("no"); }, getPrototypeOf() { throw new Error("no"); } })],
  ];

  it.each(odd)("never throws, and says nothing of it: %s", (_label, value) => {
    inApp(true);
    expect(() => logRenderError(value, value)).not.toThrow();
    expect(() => logRejection(value)).not.toThrow();
    expect(() => logLmFailure(value, value, value)).not.toThrow();
    expect(() => logWindowError({ error: value, filename: value, lineno: value, colno: value } as unknown as ErrorEvent)).not.toThrow();
    expect(JSON.stringify(sent())).not.toContain(MARKER);
    expect(sent().length).toBeGreaterThan(0);
  });

  it("never throws when the transport throws or rejects", async () => {
    inApp(true);
    core.invoke.mockImplementation(() => { throw new Error("no ipc"); });
    expect(() => logRejection(marked())).not.toThrow();
    core.invoke.mockImplementation(async () => { throw new Error("no ipc"); });
    expect(() => logRejection(marked())).not.toThrow();
    core.invoke.mockImplementation((() => undefined) as never);
    expect(() => logRejection(marked())).not.toThrow();
    await Promise.resolve();
  });

  it("looks at nothing outside the Tauri app", () => {
    const trap = new Proxy({}, { get() { throw new Error("looked"); } });
    expect(() => { logRenderError(trap, trap); logRejection(trap); logLmFailure(trap, trap, trap); }).not.toThrow();
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
