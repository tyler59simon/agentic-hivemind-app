import { useEffect, useState } from "react";
import type { EngineInfo } from "../../lib/agent";
import { termClose } from "../../lib/term";
import { dispose, useLive } from "../terminal/registry";
import { TerminalView } from "../terminal/TerminalView";
import { Modal } from "../../ui/Modal";

/** Manage connection: starts the engine's own sign-in in a terminal. Hivemind never sees the sign-in itself. */
export function ConnectionDialog({ engine, onClose }: { engine: EngineInfo; onClose: () => void }) {
  const id = `login-${engine.engine}`;
  const [opened, setOpened] = useState(false);
  const live = useLive(id);
  const [ran, setRan] = useState(false);
  useEffect(() => { if (live?.running) setRan(true); }, [live?.running]);
  const finished = ran && !live?.running;

  const close = () => {
    termClose(id).catch(() => undefined);
    dispose(id);
    onClose();
  };

  return (
    <Modal title={`${engine.label} connection`} onClose={close} wide>
      <p>Hivemind does not store or handle your sign-in. It starts {engine.label} on this computer, and {engine.label} uses the sign-in it has saved itself.</p>
      {engine.path ? <p className="muted small">Program: {engine.path}</p> : <p className="error small">{engine.error}</p>}
      {engine.engine === "codex" && <p className="muted small">Codex keeps its own list of trusted folders and its own session history. Sessions started here appear there too.</p>}
      <p className="muted small">In a terminal: Ctrl+Shift+K leaves the terminal. In Claude Code, hold Shift to select text with the mouse.</p>
      {opened ? (
        <>
          <div className="term-box login">
            <TerminalView id={id} sessionId={null} engine={engine.engine} start={null} label={`${engine.label} sign-in`} />
          </div>
          {finished && <p className="muted small">The sign-in command has finished.</p>}
          <div className="actions"><button onClick={close}>Close</button></div>
        </>
      ) : (
        <div className="actions">
          <button onClick={close}>Close</button>
          <button className="primary" disabled={!engine.path} onClick={() => setOpened(true)}>Open sign-in in a terminal</button>
        </div>
      )}
    </Modal>
  );
}
