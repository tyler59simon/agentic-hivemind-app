// "Compare files": pick two files, from the ones open in tabs or from disk, and open them side by side (NS-6A).
import { useState } from "react";
import { create } from "zustand";
import type { FileRef } from "../../documents/keys";
import { keyOf } from "../../documents/store";
import { classify } from "../../lib/errors";
import { fileName } from "../../lib/notebooks";
import { openDialog } from "../../lib/opens";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { openFiles, type Choice } from "./hunks";

interface PickerState { open: boolean; left: FileRef | null; show: (left?: FileRef) => void; hide: () => void }

/** Whether the picker is showing, and the file it was asked from (the left side to start with). */
export const useComparePicker = create<PickerState>()((set) => ({
  open: false,
  left: null,
  show: (left) => set({ open: true, left: left ?? null }),
  hide: () => set({ open: false, left: null }),
}));

/** The comparison of two files as a tab beside the others. */
export function openCompare(left: FileRef, right: FileRef) {
  useWorkspace.getState().openTab({ kind: "compare", compare: { left, right }, title: `${fileName(left.path)} vs ${fileName(right.path)}` });
}

function Side({ label, value, choices, onPick, onDisk }: { label: string; value: string; choices: Choice[]; onPick: (key: string) => void; onDisk: () => void }) {
  return (
    <div className="compare-side">
      <label>{label}
        <select value={value} onChange={(e) => onPick(e.target.value)}>
          <option value="">Choose a file</option>
          {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </label>
      <button onClick={onDisk}>A file from disk…</button>
    </div>
  );
}

function Picker({ start }: { start: FileRef | null }) {
  const hide = useComparePicker((s) => s.hide);
  const panes = useWorkspace((s) => s.panes);
  // Files chosen from disk are offered on both sides from then on.
  const [extra, setExtra] = useState<Choice[]>([]);
  const open = openFiles(panes);
  const choices = [...open, ...extra.filter((e) => !open.some((o) => o.key === e.key))];
  const others = choices.filter((c) => !start || c.key !== keyOf(start));
  const [left, setLeft] = useState(start ? keyOf(start) : "");
  const [right, setRight] = useState(others[0]?.key ?? "");
  const byKey = (key: string) => choices.find((c) => c.key === key)?.ref ?? (start && keyOf(start) === key ? start : null);
  // A start file that is not an open tab still appears.
  const all = start && !choices.some((c) => c.key === keyOf(start)) ? [{ ref: start, key: keyOf(start), label: fileName(start.path) }, ...choices] : choices;
  const fromDisk = (set: (key: string) => void) => async () => {
    try {
      const [ref] = await openDialog();
      if (!ref) return;
      const choice = { ref, key: keyOf(ref), label: fileName(ref.path) };
      setExtra((list) => [...list.filter((c) => c.key !== choice.key), choice]);
      set(choice.key);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  const a = byKey(left), b = byKey(right);
  return (
    <Modal title="Compare files" onClose={hide}>
      <p className="muted small">Pick two files to see their differences side by side. Files open in tabs are listed; any other file comes from disk.</p>
      <Side label="Left" value={left} choices={all} onPick={setLeft} onDisk={fromDisk(setLeft)} />
      <Side label="Right" value={right} choices={all} onPick={setRight} onDisk={fromDisk(setRight)} />
      {a && b && keyOf(a) === keyOf(b) && <p className="error">Pick two different files.</p>}
      <div className="actions">
        <button onClick={hide}>Cancel</button>
        <button className="primary" disabled={!a || !b || keyOf(a) === keyOf(b)} onClick={() => { hide(); openCompare(a!, b!); }}>Compare</button>
      </div>
    </Modal>
  );
}

/** The picker, shown when something asks for it (the palette, a page's menu). */
export function ComparePicker() {
  const { open, left } = useComparePicker();
  return open ? <Picker start={left} /> : null;
}
