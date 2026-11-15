import { describe, expect, it } from "vitest";
import { makeWriter } from "./writer";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("input writer", () => {
  it("sends input in order, one call at a time", async () => {
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    const write = makeWriter((data) => {
      calls.push(data);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    write("a");
    write("b");
    write("c");
    await tick();
    expect(calls).toEqual(["a"]);
    releases[0]();
    await tick();
    expect(calls).toEqual(["a", "bc"]);
    releases[1]();
    await tick();
    expect(calls).toEqual(["a", "bc"]);
    write("d");
    await tick();
    expect(calls).toEqual(["a", "bc", "d"]);
  });

  it("keeps going after a send rejects", async () => {
    const calls: string[] = [];
    const write = makeWriter((data) => {
      calls.push(data);
      return calls.length === 1 ? Promise.reject(new Error("closed")) : Promise.resolve();
    });
    write("a");
    await tick();
    write("b");
    await tick();
    expect(calls).toEqual(["a", "b"]);
  });
});
