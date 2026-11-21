// The ways to put an embed or a free-positioned block into a rich page (NS-3D): the same list feeds the slash menu and the
// toolbar's Insert menu. An embed opens its picker; the page changes only when the picker hands attributes back.
import type { BlockCommand } from "../../rich/slash";
import { EMBED_LABELS, type EmbedType } from "./embeds";
import { insertFreeform } from "./freeform";

export const FREEFORM_REFUSED = "A free-positioned block cannot go inside another one.";

const HINTS: Record<EmbedType, string> = {
  noteCard: "Living Memory", diagram: "Architecture Suite", codeRange: "lines of a file", pdfPage: "one page", gallery: "pictures", excalidraw: "Excalidraw",
};

/** `open` starts the picker or editor of a kind; `fail` says why a block could not go in. */
export function embedItems(open: (type: EmbedType) => void, fail: (message: string) => void): BlockCommand[] {
  const kinds = (Object.keys(EMBED_LABELS) as EmbedType[]).map((type): BlockCommand => ({ label: EMBED_LABELS[type], hint: HINTS[type], run: () => open(type) }));
  return [
    ...kinds,
    { label: "Free-positioned block", hint: "frames", run: (e) => { if (!insertFreeform(e)) fail(FREEFORM_REFUSED); } },
  ];
}
