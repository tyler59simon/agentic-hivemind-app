// Per-device conveniences kept in localStorage (shared by the main and capture windows).
import type { Mode } from "../workspace/store";
import { TYPE_CHOICES, TYPE_DEFAULTS, type TypeKey, type TypeValue } from "./fonts";
import type { ThemeChoice } from "./theme";
import type { PaperDefault } from "./paper";

const get = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const set = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };

/** What each appearance setting is when nothing was chosen (DESK-11): the getters below fall back to it, and so does a
 *  refused save when the settings file holds nothing for the key (lib/appearance). */
export const APPEARANCE_DEFAULTS = {
  theme: "purple" as ThemeChoice, document_background: "theme" as PaperDefault, document_size: 1, default_mode: "reading" as Mode, spellcheck: true,
  ...TYPE_DEFAULTS,
};

export interface CaptureTarget { kind: "memory" | "today" | "inbox"; notebook: string }

export const prefs = {
  /** The copy kept here of a value that lives in the settings file (DESK-11): null when none was kept. */
  stored: get,
  defaultModeKey: "hivemind.defaultMode",
  defaultMode: (): Mode => (get("hivemind.defaultMode") as Mode | null) ?? APPEARANCE_DEFAULTS.default_mode,
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
    return saved === "purple" || saved === "emerald" || saved === "emerald-light" || saved === "system" ? saved : APPEARANCE_DEFAULTS.theme;
  },
  setTheme: (theme: ThemeChoice) => set("hivemind.theme", theme),
  paperKey: "hivemind.documentBackground",
  paper: (): PaperDefault => { const saved = get("hivemind.documentBackground"); return saved === "white" || saved === "theme" ? saved : APPEARANCE_DEFAULTS.document_background; },
  setPaper: (paper: PaperDefault) => set("hivemind.documentBackground", paper),
  spellcheckKey: "hivemind.spellcheck",
  /** Whether notes are spell-checked: on unless it was turned off. */
  spellcheck: (): boolean => { const saved = get("hivemind.spellcheck"); return saved === "1" ? true : saved === "0" ? false : APPEARANCE_DEFAULTS.spellcheck; },
  setSpellcheck: (on: boolean) => set("hivemind.spellcheck", on ? "1" : "0"),
  /** The localStorage key of each typography and density setting (DESK-TYPE). */
  typeKeys: { ui_font: "hivemind.uiFont", doc_font: "hivemind.docFont", mono_font: "hivemind.monoFont", doc_line_height: "hivemind.docLineHeight", doc_width: "hivemind.docWidth", density: "hivemind.density" } as Record<TypeKey, string>,
  /** The copy of a typography or density setting: the default when none was kept or it is not a known value. */
  typeValue: <K extends TypeKey>(key: K): TypeValue<K> => {
    const saved = get(prefs.typeKeys[key]);
    const known = TYPE_CHOICES[key].find((c) => String(c.value) === saved);
    return (known?.value ?? TYPE_DEFAULTS[key]) as TypeValue<K>;
  },
  setTypeValue: (key: TypeKey, value: string | number) => set(prefs.typeKeys[key], String(value)),
  docSizeKey: "hivemind.documentSize",
  /** The document text size multiple; 1 when unset or not a number. */
  docSize: (): number => { const n = Number(get("hivemind.documentSize")); return Number.isFinite(n) && n > 0 ? n : APPEARANCE_DEFAULTS.document_size; },
  setDocSize: (size: number) => set("hivemind.documentSize", String(size)),
};
