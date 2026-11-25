// Per-device conveniences kept in localStorage (shared by the main and capture windows).
import type { Mode } from "../workspace/store";
import type { ThemeChoice } from "./theme";
import type { PaperDefault } from "./paper";

const get = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const set = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };

export interface CaptureTarget { kind: "memory" | "today" | "inbox"; notebook: string }

export const prefs = {
  /** The copy kept here of a value that lives in the settings file (DESK-11): null when none was kept. */
  stored: get,
  defaultModeKey: "hivemind.defaultMode",
  defaultMode: (): Mode => (get("hivemind.defaultMode") as Mode | null) ?? "reading",
  setDefaultMode: (mode: Mode) => set("hivemind.defaultMode", mode),
  captureDomain: () => get("hivemind.captureDomain"),
  setCaptureDomain: (domain: string) => set("hivemind.captureDomain", domain),
  /** Where Quick capture adds a note: a Memory note, or a notebook's Today page or Inbox (NS-7A). */
  captureTarget: (): CaptureTarget => {
    try {
      const saved = JSON.parse(get("hivemind.captureTarget") ?? "null") as Partial<CaptureTarget> | null;
      const kind = saved?.kind === "today" || saved?.kind === "inbox" ? saved.kind : "memory";
      return { kind, notebook: typeof saved?.notebook === "string" ? saved.notebook : "" };
    } catch { return { kind: "memory", notebook: "" }; }
  },
  setCaptureTarget: (target: CaptureTarget) => set("hivemind.captureTarget", JSON.stringify(target)),
  trayNoticeShown: () => get("hivemind.trayNotice") === "1",
  setTrayNoticeShown: () => set("hivemind.trayNotice", "1"),
  captureProject: () => get("hivemind.captureProject"),
  setCaptureProject: (slug: string) => set("hivemind.captureProject", slug),
  themeKey: "hivemind.theme",
  theme: (): ThemeChoice => {
    const saved = get("hivemind.theme");
    return saved === "emerald" || saved === "emerald-light" || saved === "system" ? saved : "purple";
  },
  setTheme: (theme: ThemeChoice) => set("hivemind.theme", theme),
  paperKey: "hivemind.documentBackground",
  paper: (): PaperDefault => (get("hivemind.documentBackground") === "white" ? "white" : "theme"),
  setPaper: (paper: PaperDefault) => set("hivemind.documentBackground", paper),
  spellcheckKey: "hivemind.spellcheck",
  /** Whether notes are spell-checked: on unless it was turned off. */
  spellcheck: (): boolean => get("hivemind.spellcheck") !== "0",
  setSpellcheck: (on: boolean) => set("hivemind.spellcheck", on ? "1" : "0"),
  docSizeKey: "hivemind.documentSize",
  /** The document text size multiple; 1 when unset or not a number. */
  docSize: (): number => { const n = Number(get("hivemind.documentSize")); return Number.isFinite(n) && n > 0 ? n : 1; },
  setDocSize: (size: number) => set("hivemind.documentSize", String(size)),
};
