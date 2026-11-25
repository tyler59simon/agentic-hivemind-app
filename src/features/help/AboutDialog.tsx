// About Hivemind (DESK-HELP): the version, what it runs on, the folders it keeps its files in and the Living Memory it is
// connected to. Opened from the Help items of the account menu and the palette.
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { appInfo } from "../../lib/diagnostics";
import { connect } from "../../lib/lm";
import { announce } from "../../ui/announce";
import { Modal } from "../../ui/Modal";

interface DialogState {
  open: boolean;
  /** The control to give the focus back to on close: the one focused when the dialog was asked for, unless the caller knows better (the palette, which is gone by then). */
  returnTo: HTMLElement | null;
  show: (from?: Element | null) => void;
  hide: () => void;
}
export const useAboutDialog = create<DialogState>((set) => ({
  open: false, returnTo: null,
  show: (from) => set({ open: true, returnTo: (from ?? document.activeElement) as HTMLElement | null }),
  hide: () => set({ open: false }),
}));

/** Put the focus back where the dialog was asked for, or on the main region when that control is gone. Only once it has been closed (Strict Mode runs a cleanup while it is open). */
function giveFocusBack(): void {
  const { returnTo, open } = useAboutDialog.getState();
  if (open) return;
  const target = returnTo?.isConnected && returnTo !== document.body ? returnTo : document.querySelector<HTMLElement>("main");
  if (!target) return;
  if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

export function AboutDialog() {
  const open = useAboutDialog((s) => s.open);
  return open ? <About /> : null;
}

function FolderRow({ label, path }: { label: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      announce("Copied");
    } catch {
      announce("Could not copy", "assertive");
    }
  };
  return (
    <div className="about-row">
      <dt>{label}</dt>
      <dd><code>{path}</code> <button type="button" className="ghost" aria-label={`Copy the ${label.toLowerCase()}`} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button></dd>
    </div>
  );
}

function About() {
  const hide = useAboutDialog((s) => s.hide);
  const info = useQuery({ queryKey: ["app_info"], queryFn: appInfo, retry: false });
  // The connection the app already made: read from its cache, never asked again here.
  const link = useQuery({ queryKey: ["connect"], queryFn: connect, enabled: false });
  // Before the modal's own restore (a microtask after the commit), which only handles a focus that went to the page body.
  useLayoutEffect(() => giveFocusBack, []);
  const d = info.data;
  return (
    <Modal title="About Hivemind" onClose={hide}>
      {info.isLoading && <p className="muted" role="status">Loading…</p>}
      {info.isError && <p className="error" role="alert">Could not read the app information: {info.error instanceof Error ? info.error.message : String(info.error)}</p>}
      {d && (
        <dl className="about-list">
          <div className="about-row"><dt>Hivemind</dt><dd>{d.version}</dd></div>
          <div className="about-row"><dt>Tauri</dt><dd>{d.tauri}</dd></div>
          <div className="about-row"><dt>{d.webviewEngine}</dt><dd>{d.webview}</dd></div>
          <div className="about-row"><dt>System</dt><dd>{[d.os, d.arch].join(" ")}{d.osVersion ? `, ${d.osVersion}` : ""}</dd></div>
          <FolderRow label="Data folder" path={d.dataDir} />
          <FolderRow label="Config folder" path={d.configDir} />
          <FolderRow label="Log folder" path={d.logDir} />
        </dl>
      )}
      <dl className="about-list">
        <div className="about-row"><dt>Living Memory</dt><dd>{link.data ? `Connected, API version ${link.data.version.api}` : link.isError ? "Not connected" : "Connecting…"}</dd></div>
      </dl>
      <div className="actions"><button className="primary" autoFocus onClick={hide}>Close</button></div>
    </Modal>
  );
}
