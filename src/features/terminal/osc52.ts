/** The text an OSC 52 payload (`<selector>;<base64>`) asks to put on the clipboard, or null for a read request ("?"),
 *  an empty payload or data that is not base64 of UTF-8 text. Any selector (c, p, s, ...) is accepted. */
export function decodeOsc52(payload: string): string | null {
  const cut = payload.indexOf(";");
  if (cut < 0) return null;
  const data = payload.slice(cut + 1).trim();
  if (data === "" || data === "?") return null;
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
