import { describe, expect, it } from "vitest";
import { pictureUrl } from "./pictures";

const base = "http://hmfile.localhost/g1/";

describe("pictureUrl", () => {
  it("resolves a relative picture against the page's folder and encodes each part", () => {
    expect(pictureUrl("img/cat one.png", base, "Projects")).toBe(`${base}Projects/img/cat%20one.png`);
    expect(pictureUrl("../shared/a%20b.png", base, "Projects/Q3")).toBe(`${base}Projects/shared/a%20b.png`);
    expect(pictureUrl("./x.png?v=2#top", base, "")).toBe(`${base}x.png`);
    expect(pictureUrl("100%.png", base, "")).toBeNull();
  });

  it("loads web pictures as they are and nothing outside the grant", () => {
    expect(pictureUrl("https://example.com/a.png", base, "")).toBe("https://example.com/a.png");
    for (const bad of ["../a.png", "../../etc/x.png", "file:///C:/x.png", "C:\\x.png", "/abs.png", "\\\\server\\x.png", "data:image/png;base64,AA", ""]) {
      expect(pictureUrl(bad, base, "")).toBeNull();
    }
    expect(pictureUrl("a.png", undefined, "")).toBeNull();
  });
});
