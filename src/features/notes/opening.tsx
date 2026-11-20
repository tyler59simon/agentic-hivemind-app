import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import type { FileRef } from "../../documents/keys";
import { addDroppedNotebook, LOOSE, openDialog, openForget, openPending, recentQuery } from "../../lib/opens";
import { Confirm } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { closeTabsUnder, openPage } from "./actions";

/** Pick files with the native dialog and open each in a tab. */
export async function openFromDisk() {
  try {
    for (const ref of await openDialog()) openPage(ref);
  } catch (e) {
    toast(classify(e).message, "error");
  }
}

/** Take a loose file off the recent list and close its tabs; the file itself is untouched. */
export async function forgetRecent(ref: FileRef, client: { invalidateQueries: (q: { queryKey: unknown[] }) => unknown }) {
  try {
    await openForget(ref.notebook.slice(LOOSE.length));
    closeTabsUnder(ref.notebook, ref.path);
    client.invalidateQueries({ queryKey: recentQuery().queryKey });
  } catch (e) {
    toast(classify(e).message, "error");
  }
}

/** Files from Explorer and drops on the window open as tabs; a dropped folder is offered as a notebook. The listener
 *  is in place before the queue is first drained, so a file that arrives while the app starts is never missed (phase
 *  1B, U2). Returns the dialog to render. */
export function useOpenRequests() {
  const client = useQueryClient();
  const [offer, setOffer] = useState<{ token: string; name: string } | null>(null);
  useEffect(() => {
    let stopped = false;
    const drain = () => openPending().then(
      (refs) => {
        // Rust has handed these over, so they open even if this effect ended meanwhile (Codex review of 52051c8, I1).
        refs.forEach((ref) => openPage(ref));
        if (refs.length) client.invalidateQueries({ queryKey: recentQuery().queryKey });
      },
      (e) => toast(classify(e).message, "error"),
    );
    const stops = [
      listen("open-requested", () => void drain()),
      listen<{ token: string; name: string }>("folder-dropped", (e) => setOffer(e.payload)),
    ];
    // An effect that ended before its listeners were in place (Strict Mode runs effects twice) leaves the queue to the
    // one that follows it.
    void Promise.all(stops).then(() => { if (!stopped) void drain(); });
    return () => { stopped = true; stops.forEach((s) => s.then((unlisten) => unlisten())); };
  }, [client]);
  return offer && (
    <Confirm title="Add this folder as a notebook?" action="Add notebook"
      message={<p><code>{offer.name}</code> becomes a notebook: its pages show on the Notes page, and Hivemind edits them in place.</p>}
      onAnswer={(yes) => {
        const { token } = offer;
        setOffer(null);
        if (!yes) return;
        addDroppedNotebook(token).then((nb) => {
          client.invalidateQueries({ queryKey: ["notebooks"] });
          toast(`Added ${nb.title}.`);
        }, (e) => toast(classify(e).message, "error"));
      }} />
  );
}
