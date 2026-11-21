// The embeds of a rich page (NS-3D): atom blocks that each store what they need to draw again, plus a `title` that a
// placeholder and the extracted text show. Drawing one never writes the page; only inserting one, updating it or editing
// a drawing changes attributes. Every attribute has a rule in `rules.ts`, and the defaults here are only what Tiptap needs
// to build a node: the rules refuse the ones that are not real values (an empty path), so no node holds them by chance.
import { atom } from "../../rich/schema";

/** A note of Living Memory, drawn from `read`. */
export const NoteCard = atom("noteCard", false, { ref: "", title: "" });
/** A diagram of a system's Architecture Suite output, by system slug and the path its manifest lists. */
export const Diagram = atom("diagram", false, { system: "", path: "", title: "" });
/** Lines of a file of the notebook, with a copy of them and their hash. */
export const CodeRange = atom("codeRange", false, { file: "", from: 1, to: 1, sha256: "", text: "", language: "", title: "" });
/** One page of a PDF of the notebook. */
export const PdfPage = atom("pdfPage", false, { file: "", page: 1, title: "" });
/** Pictures of the notebook in two to four columns. */
export const Gallery = atom("gallery", false, { images: [] as string[], columns: 3, title: "" });
/** A drawing: the Excalidraw scene file and the PNG that stands for it, both in the notebook. */
export const Drawing = atom("excalidraw", false, { scene: "", preview: "", title: "" });

export const EMBEDS = [NoteCard, Diagram, CodeRange, PdfPage, Gallery, Drawing];

export type EmbedType = "noteCard" | "diagram" | "codeRange" | "pdfPage" | "gallery" | "excalidraw";
export const EMBED_TYPES: readonly EmbedType[] = ["noteCard", "diagram", "codeRange", "pdfPage", "gallery", "excalidraw"];
export const isEmbed = (name: string): name is EmbedType => (EMBED_TYPES as readonly string[]).includes(name);

/** What each kind is called in menus and placeholders. */
export const EMBED_LABELS: Record<EmbedType, string> = {
  noteCard: "Memory note", diagram: "Architecture diagram", codeRange: "Code range", pdfPage: "PDF page", gallery: "Gallery", excalidraw: "Drawing",
};
