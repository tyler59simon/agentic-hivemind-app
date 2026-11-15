import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { agentAuthStatus, type EngineInfo } from "../../lib/agent";
import { termClose } from "../../lib/term";
import { dispose, useLive } from "../terminal/registry";
import { TerminalView } from "../terminal/TerminalView";
import { Modal } from "../../ui/Modal";
import { anotherAccountWarning, authView } from "./auth";

/** Manage connection: starts the engine's own sign-in in a terminal. Hivemind never sees the sign-in itself. */
export function ConnectionDialog({ engine, onClose }: { engine: EngineInfo; onClose: () => void }) {
  const id = `login-${engine.engine}`;
  const [opened, setOpened] = useState(false);
  const live = useLive(id);
  const [ran, setRan] = useState(false);
  useEffect(() => { if (live?.running) setRan(true); }, [live?.running]);
  const finished = ran && !live?.running;
  // The CLI's own status command, once when the dialog opens (and again when a sign-in has finished); no polling.
  const status = useQuery({ queryKey: ["agent", "auth", engine.engine], queryFn: () => agentAuthStatus(engine.engine), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  useEffect(() => { if (finished) status.refetch(); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const auth = authView(status.data, status.isFetching, status.isError);
  const [confirming, setConfirming] = useState(false);

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
      <p role="status"><strong>{auth.label}</strong></p>
      {engine.engine === "codex" && (auth.signIn || opened) && <p className="warn-text small">Codex starts a new sign-in even when you are already signed in. If you close this before finishing it, Codex is left signed out.</p>}
      <p className="muted small">In a terminal: Ctrl+Shift+K leaves the terminal. In Claude Code, hold Shift to select text with the mouse.</p>
      {opened ? (
        <>
          <div className="term-box login">
            <TerminalView id={id} sessionId={null} engine={engine.engine} start={null} label={`${engine.label} sign-in`} />
          </div>
          {finished && <p className="muted small">The sign-in command has finished.</p>}
          <div className="actions"><button onClick={close}>Close</button></div>
        </>
      ) : confirming ? (
        <>
          <div className="banner warn" role="alert">{anotherAccountWarning(engine.engine)}</div>
          <div className="actions">
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button className="primary" disabled={!engine.path} onClick={() => { setConfirming(false); setOpened(true); }}>Sign in with another account</button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button onClick={close}>Close</button>
          {auth.another && <button disabled={!engine.path} onClick={() => setConfirming(true)}>Sign in with another account</button>}
          {auth.signIn && <button className="primary" disabled={!engine.path} onClick={() => setOpened(true)}>Sign in</button>}
        </div>
      )}
    </Modal>
  );
}
