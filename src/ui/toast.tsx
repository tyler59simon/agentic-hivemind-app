import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { announce } from "./announce";

export interface Toast { id: number; text: string; kind: "info" | "warn" | "error"; action?: { label: string; run: () => void } }
interface Toasts { items: Toast[]; push: (text: string, kind?: Toast["kind"], action?: Toast["action"]) => void; dismiss: (id: number) => void }

/** How long a toast stays. One with an action (Undo) stays at least 10 seconds after the pointer or focus leaves it, so
 *  there is time to reach it (WCAG 2.2.1, DESK-7). */
export const toastMs = (t: Pick<Toast, "kind" | "action">): number => Math.max(t.kind === "error" ? 9000 : 5000, t.action ? 10000 : 0);

let next = 1;
export const useToasts = create<Toasts>((set, get) => ({
  items: [],
  push: (text, kind = "info", action) => {
    const id = next++;
    set({ items: [...get().items.slice(-4), { id, text, kind, action }] });
    // The visible list is not a live region: the announcer reads the text once, errors at once.
    announce(action ? `${text}. ${action.label} is in the notifications.` : text, kind === "error" ? "assertive" : "polite");
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));
export const toast = (text: string, kind?: Toast["kind"], action?: Toast["action"]) => useToasts.getState().push(text, kind, action);

/** Counts a toast down while the list is not paused; on pause it keeps the time left. */
function useCountdown(t: Toast, paused: boolean, done: () => void) {
  const left = useRef(toastMs(t));
  const finish = useRef(done);
  finish.current = done;
  useEffect(() => {
    if (paused) return;
    const wait = t.action ? Math.max(left.current, 10000) : left.current;
    const start = Date.now();
    const timer = setTimeout(() => finish.current(), wait);
    return () => { clearTimeout(timer); left.current = Math.max(0, wait - (Date.now() - start)); };
  }, [paused, t.action]);
}

function ToastItem({ t, paused, dismiss }: { t: Toast; paused: boolean; dismiss: (id: number) => void }) {
  useCountdown(t, paused, () => dismiss(t.id));
  return t.action ? (
    <div className={`toast with-action ${t.kind}`}>
      <span>{t.text}</span>
      <button className="link" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>
    </div>
  ) : (
    <button className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.text}</button>
  );
}

/** The visible toasts. They wait while the pointer is over them or one has the focus. */
export function Toasts() {
  const { items, dismiss } = useToasts();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <div className="toasts" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); }}>
      {items.map((t) => <ToastItem key={t.id} t={t} paused={hover || focus} dismiss={dismiss} />)}
    </div>
  );
}
