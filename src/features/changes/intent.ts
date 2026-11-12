import { create } from "zustand";
import type { Change } from "../../lib/lm";
import type { ChangeFields } from "./wizard";

export type ChangeForm =
  | { mode: "create" }
  | { mode: "adopt"; ref: string; title: string }
  | { mode: "edit"; change: Change };

export type { ChangeFields };

/** Which change form is open. Opened from the Changes page, the Overview, a note's menu and the command palette. */
export const useChangeIntent = create<{ form: ChangeForm | null; open: (form?: ChangeForm) => void; close: () => void }>((set) => ({
  form: null,
  open: (form = { mode: "create" }) => set({ form }),
  close: () => set({ form: null }),
}));
