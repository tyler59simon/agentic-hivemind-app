// Per-device conveniences kept in localStorage (shared by the main and capture windows).
import type { Mode } from "../workspace/store";

const get = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const set = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };

export const prefs = {
  defaultMode: (): Mode => (get("hivemind.defaultMode") as Mode | null) ?? "reading",
  setDefaultMode: (mode: Mode) => set("hivemind.defaultMode", mode),
  captureDomain: () => get("hivemind.captureDomain"),
  setCaptureDomain: (domain: string) => set("hivemind.captureDomain", domain),
  trayNoticeShown: () => get("hivemind.trayNotice") === "1",
  setTrayNoticeShown: () => set("hivemind.trayNotice", "1"),
  captureProject: () => get("hivemind.captureProject"),
  setCaptureProject: (slug: string) => set("hivemind.captureProject", slug),
};
