// Shared binary version history timeline for `.docx` and `.pdf` tabs (list, pin, and restore raw snapshots).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, PinOff, RotateCcw } from "lucide-react";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
import { historyList, historyPin } from "../../lib/history";
import { toast } from "../../ui/toast";

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function BinaryHistory({
  file,
  stampSha,
  canRestore,
  onRestore,
}: {
  file: FileRef;
  stampSha?: string;
  canRestore: boolean;
  onRestore: (id: number) => Promise<boolean>;
}) {
  const client = useQueryClient();
  const kept = useQuery({
    queryKey: ["file-history", file.notebook, file.path, stampSha],
    queryFn: () => historyList(file.notebook, file.path),
  });

  const pin = useMutation({
    mutationFn: ({ id, pinned }: { id: number; pinned: boolean }) => historyPin(file.notebook, file.path, id, pinned),
    onSuccess: () => client.invalidateQueries({ queryKey: ["file-history", file.notebook, file.path] }),
    onError: (e) => toast(classify(e).message, "error"),
  });

  const restore = useMutation({
    mutationFn: (id: number) => onRestore(id),
    onSuccess: (ok) => {
      if (ok) {
        toast("Restored selected version. The previous version stays in history.");
        client.invalidateQueries({ queryKey: ["file-history", file.notebook, file.path] });
      } else {
        toast("Could not restore: save or discard your current edits first.", "warn");
      }
    },
    onError: (e) => toast(classify(e).message, "error"),
  });

  if (kept.isLoading) return <div className="center muted">Loading version history…</div>;
  if (kept.error) return <div className="center"><p className="error">{classify(kept.error).message}</p></div>;
  const entries = kept.data?.entries ?? [];

  return (
    <div className="binary-history">
      {kept.data?.tooLarge && (
        <div className="banner note-banner">This file is over 16 MB, so automatic version snapshots are skipped.</div>
      )}
      {!entries.length ? (
        <div className="center muted">No snapshots kept yet. Hivemind keeps a copy of the original file before each save.</div>
      ) : (
        <ul className="card-list">
          {entries.map((entry) => {
            const isCurrent = entry.sha256 === stampSha;
            return (
              <li key={entry.id} className="binary-history-row">
                <div>
                  <strong>{new Date(entry.time).toLocaleString()}</strong>
                  <span className="muted small"> · {fmtSize(entry.size)} · {entry.source}{isCurrent ? " (current)" : ""}</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    title={entry.pinned ? "Unpin version" : "Pin version"}
                    onClick={() => pin.mutate({ id: entry.id, pinned: !entry.pinned })}
                  >
                    {entry.pinned ? <PinOff size="0.95em" aria-hidden /> : <Pin size="0.95em" aria-hidden />}
                    {entry.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={isCurrent || !canRestore || restore.isPending}
                    onClick={() => restore.mutate(entry.id)}
                  >
                    <RotateCcw size="0.95em" aria-hidden /> Restore
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
