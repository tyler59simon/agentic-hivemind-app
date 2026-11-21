// NS-3D: the SHA-256 a code range is stored with must be the standard one, so the stored hash of a page written elsewhere
// (or by the Rust side one day) compares equal.
import { describe, expect, it } from "vitest";
import { sha256 } from "./hash";

describe("sha256", () => {
  it("matches the standard test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256("The quick brown fox jumps over the lazy dog")).toBe("d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
  });

  it("handles messages around the block boundary and a long one", () => {
    // 55, 56 and 64 bytes: where the padding and the length spill into another block.
    expect(sha256("a".repeat(55))).toBe("9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
    expect(sha256("a".repeat(56))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
    expect(sha256("a".repeat(64))).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
    expect(sha256("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("hashes text as UTF-8", () => {
    // The page of the embeds fixture was hashed with Python's hashlib over the UTF-8 bytes.
    expect(sha256("export function add(a: number, b: number) {\n  return a + b;\n}")).toBe("3e934c7521b5d274ebc11463774c1cbbaa11be25f36bbad1b19af529a95c4e12");
    expect(sha256("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
  });
});
