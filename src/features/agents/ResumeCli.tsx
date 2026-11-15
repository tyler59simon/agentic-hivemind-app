import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { agentImport, asksNobody, cliHistory, type Access, type Engine, type HistoryTarget } from "../../lib/agent";
import { ago } from "../../lib/text";
import { openSession } from "../../store";
import { toast } from "../../ui/toast";
import { conversationAction } from "./start";

/** "Resume a CLI conversation": what the engine saved for the chosen folder, loaded only when the section is opened. */
export function ResumeCli({ engine, target, access, model, effort, confirmed }: {
  engine: Engine; target: HistoryTarget; access: Access; model: string; effort: string;
  /** The confirm box for a mode that never asks. */
  confirmed: boolean;
}) {
  const risky = asksNobody(access);
  const blocked = risky && !confirmed;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const history = useQuery({ queryKey: ["agent", "history", engine, target], queryFn: () => cliHistory(engine, target), enabled: open, staleTime: 0, retry: false });

  const pick = async (id: string, hivemindSession: string | null) => {
    if (conversationAction({ hivemindSession }) === "open") { openSession(hivemindSession!); return; }
    setBusy(id);
    try {
      const info = await agentImport({ engine, cliId: id, target, access, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(risky ? { confirmedRisky: true } : {}) });
      client.invalidateQueries({ queryKey: ["agent", "sessions"] });
      client.invalidateQueries({ queryKey: ["agent", "history"] });
      openSession(info.id);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="start-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Resume a CLI conversation</summary>
      {history.isLoading && <p className="muted small">Loading…</p>}
      {history.isError && <p className="error small">{String(history.error)}</p>}
      {history.data && !history.data.length && <p className="muted small">No saved conversations here yet.</p>}
      {blocked && !!history.data?.length && <p className="muted small">Tick the box under Permissions first: the permission mode you picked never asks.</p>}
      {!!history.data?.length && (
        <ul className="resume-list">
          {history.data.map((c) => (
            <li key={c.id}>
              <button type="button" className="text resume-row" disabled={busy !== null || (blocked && !c.hivemindSession)} onClick={() => pick(c.id, c.hivemindSession)}>
                <span className="grow">{c.title}</span>
                <span className="muted small">{c.hivemindSession ? "Open in Hivemind · " : ""}{ago(c.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
