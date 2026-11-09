import { create } from "zustand";

export interface Toast { id: number; text: string; kind: "info" | "warn" | "error" }
interface Toasts { items: Toast[]; push: (text: string, kind?: Toast["kind"]) => void; dismiss: (id: number) => void }

let next = 1;
export const useToasts = create<Toasts>((set, get) => ({
  items: [],
  push: (text, kind = "info") => {
    const id = next++;
    set({ items: [...get().items.slice(-4), { id, text, kind }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : 5000);
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));
export const toast = (text: string, kind?: Toast["kind"]) => useToasts.getState().push(text, kind);

export function Toasts() {
  const { items, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.text}</button>
      ))}
    </div>
  );
}
