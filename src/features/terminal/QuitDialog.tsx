import { Modal } from "../../ui/Modal";

/** Tray Quit while something runs: names what will stop. */
export function QuitDialog({ lines, onKeep, onQuit }: { lines: string[]; onKeep: () => void; onQuit: () => void }) {
  return (
    <Modal title="Quit Hivemind?" onClose={onKeep}>
      <p>These are still running and will be stopped:</p>
      <ul>{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <div className="actions">
        <button autoFocus onClick={onKeep}>Keep running</button>
        <button className="danger" onClick={onQuit}>Quit and stop them</button>
      </div>
    </Modal>
  );
}
