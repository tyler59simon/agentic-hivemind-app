import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, SquarePen } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { confirm } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { toast } from "../../ui/toast";
import { dayMonth, Tabs } from "../../ui/Page";
import { useWorkspace, type Tab } from "../../workspace/store";
import { HistoryPanel } from "../history/HistoryViews";
import { NoteMenu } from "../plans/NoteMenu";
import { NoteTags, NoteView, noteQuery } from "../viewer/NoteView";
import { NoteEditor } from "./NoteEditor";

type View = "reading" | "source" | "history";
const VIEWS: { id: View; label: string }[] = [{ id: "reading", label: "Reading" }, { id: "source", label: "Source" }, { id: "history", label: "History" }];

/** A note page: type, title, status and actions; Reading / Source / History; then the note or its editor. */
export function NoteTab({ tab }: { tab: Tab }) {
  const refId = tab.ref!;
  const client = useQueryClient();
  const updateTab = useWorkspace((s) => s.updateTab);
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  const note = useQuery(noteQuery(refId));
  // The editor draws its title field and Save button here, where the reading view has the title.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const mode = tab.mode ?? "reading";
  const editing = mode === "live" || mode === "source";
  const n = note.data;
  const still = useMutation({
    mutationFn: () => confirm(refId),
    onSuccess: (r) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["note", refId] });
      toast(r.status === "unchanged" ? "Already confirmed today." : `Confirmed. Next review ${r.review_by ?? "later"}.`);
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const confirmed = n?.confirmed?.length ? n.confirmed[n.confirmed.length - 1] : undefined;

  return (
    <div className="note-page">
      <header className="note-header">
        <div className="note-top">
          <span className="eyebrow">{n?.type ?? "note"}</span>
          <span className="fill" />
          <button className={`text ${mode === "live" ? "on" : ""}`} title="Edit with a live preview (Ctrl+E)"
            onClick={() => updateTab(tab.id, { mode: mode === "live" ? "reading" : "live" })}>
            <SquarePen size="1.15em" aria-hidden />{mode === "live" ? "Done editing" : "Edit"}
          </button>
          {n?.status === "active" && !editing && (
            <button className="primary" onClick={() => still.mutate()} disabled={still.isPending} title="Confirm this note still holds (pushes its review date out)">
              <Check size="1.15em" aria-hidden />Still true
            </button>
          )}
          <NoteMenu refId={refId} />
        </div>
        {editing ? <div ref={setHead} /> : n && (
          <>
            <h1 onDoubleClick={() => updateTab(tab.id, { mode: "live" })} title="Double-click to edit">{n.title}</h1>
            <div className="page-meta">
              <span className={`status-chip cap ${n.status}`}>{n.status === "active" && <CircleCheck size="1.1em" aria-hidden />}{n.status}</span>
              <span className="muted">{confirmed ? `Confirmed ${dayMonth(confirmed)}` : `Updated ${dayMonth(n.updated)}`}</span>
              <NoteTags note={n} />
            </div>
          </>
        )}
        <Tabs items={VIEWS} value={mode === "live" ? "reading" : mode} label="Note view"
          onChange={(v) => updateTab(tab.id, { mode: v === "reading" && mode === "live" ? "live" : v })} />
      </header>
      {mode === "reading" && dirty && (
        <div className="banner warn note-banner">This shows the saved note; your unsaved edits are kept as a draft.
          <div className="actions"><button onClick={() => updateTab(tab.id, { mode: "live" })}>Back to editing</button></div>
        </div>
      )}
      {mode === "reading" ? <NoteView refId={refId} tabId={tab.id} />
        : mode === "history" ? <div className="note"><HistoryPanel key={refId} tab={tab} /></div>
        : head && <NoteEditor key={refId} tab={tab} live={mode === "live"} head={head} />}
    </div>
  );
}
