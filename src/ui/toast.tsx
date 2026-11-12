import { create } from "zustand";

export interface Toast { id: number; text: string; kind: "info" | "warn" | "error"; action?: { label: string; run: () => void } }
interface Toasts { items: Toast[]; push: (text: string, kind?: Toast["kind"], action?: Toast["action"]) => void; dismiss: (id: number) => void }

let next = 1;
export const useToasts = create<Toasts>((set, get) => ({
  items: [],
  push: (text, kind = "info", action) => {
    const id = next++;
    set({ items: [...get().items.slice(-4), { id, text, kind, action }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : 5000);
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));
export const toast = (text: string, kind?: Toast["kind"], action?: Toast["action"]) => useToasts.getState().push(text, kind, action);

export function Toasts() {
  const { items, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => t.action ? (
        <div key={t.id} className={`toast with-action ${t.kind}`}>
          <span>{t.text}</span>
          <button className="link" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>
        </div>
      ) : (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.text}</button>
      ))}
    </div>
  );
}
