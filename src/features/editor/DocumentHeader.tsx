import type { ReactNode } from "react";
import { Tabs } from "../../ui/Page";
import type { Mode } from "../../workspace/store";

export const HISTORY_MODE = { id: "history", label: "History" } as const;
export const MARKDOWN_MODES: { id: Mode; label: string }[] = [
  { id: "reading", label: "Reading" },
  { id: "live", label: "Live" },
  { id: "source", label: "Source" },
  HISTORY_MODE,
];

export function DocumentHeader({ top, modes, mode, label, onMode, children }: {
  top: ReactNode;
  modes: { id: Mode; label: string }[];
  mode: Mode;
  label: string;
  onMode: (mode: Mode) => void;
  children?: ReactNode;
}) {
  return (
    <header className="note-header">
      <div className="note-top">{top}</div>
      {children}
      <Tabs items={modes} value={mode} label={label} onChange={onMode} />
    </header>
  );
}
