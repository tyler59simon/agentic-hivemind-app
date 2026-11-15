import { describe, expect, it } from "vitest";
import { decodeOsc52 } from "./osc52";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("decodeOsc52", () => {
  it("decodes a clipboard write", () => {
    expect(decodeOsc52(`c;${b64("hello")}`)).toBe("hello");
  });
  it("accepts other selectors", () => {
    expect(decodeOsc52(`p;${b64("a")}`)).toBe("a");
    expect(decodeOsc52(`s;${b64("b")}`)).toBe("b");
    expect(decodeOsc52(`;${b64("c")}`)).toBe("c");
  });
  it("decodes UTF-8 text", () => {
    expect(decodeOsc52(`c;${b64("héllo ✓ 日本")}`)).toBe("héllo ✓ 日本");
  });
  it("ignores read requests, empty data and bad input", () => {
    expect(decodeOsc52("c;?")).toBeNull();
    expect(decodeOsc52("c;")).toBeNull();
    expect(decodeOsc52("c")).toBeNull();
    expect(decodeOsc52("c;***not base64***")).toBeNull();
    expect(decodeOsc52("c;/w==")).toBeNull();
  });
});
