import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Pin, PinOff, Play, ScrollText } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { usePinEnabled, useRuleEnabled, useViewsEnabled } from "../../lib/connection";
import { confirm, ruleAllowed, setPin, setRule } from "../../lib/lm";
import { useWhitePaper } from "../../lib/paper";
import { recordOperation } from "../../lib/oplog";
import { startSession } from "../../store";
import { toast } from "../../ui/toast";
import { dayMonth } from "../../ui/Page";
import { useWorkspace, type Tab } from "../../workspace/store";
import { useSessionDraft } from "../agents/draft";
import { DashboardToggle } from "../dashboards/DashboardToggle";
import { HistoryPanel } from "../history/HistoryViews";
import { NoteMenu } from "../plans/NoteMenu";
import { NoteTags, NoteView, noteQuery } from "../viewer/NoteView";
import { DocumentHeader, MARKDOWN_MODES } from "./DocumentHeader";
import { NoteEditor } from "./NoteEditor";

/** The shared document layout with Living Memory properties and actions. */
export function NoteTab({ tab }: { tab: Tab }) {
  const refId = tab.ref!;
  const client = useQueryClient();
  const updateTab = useWorkspace((s) => s.updateTab);
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  const white = useWhitePaper(tab);
  const note = useQuery(noteQuery(refId));
  // The editor draws its title field and Save button here, where the reading view has the title.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const mode = MARKDOWN_MODES.find((item) => item.id === tab.mode)?.id ?? "reading";
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
  const pin = useMutation({
    mutationFn: (on: boolean) => setPin(refId, on),
    onSuccess: (r, on) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["note", refId] });
      toast(on ? "Pinned. Maintenance will not retire this note." : "Unpinned.");
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const rule = useMutation({
    mutationFn: (on: boolean) => setRule(refId, on),
    onSuccess: (r, on) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["note", refId] });
      toast(on ? "Made a rule. It is shown in full at every session start." : "Rule removed.");
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const viewsOn = useViewsEnabled();
  const pinOn = usePinEnabled();
  const ruleOn = useRuleEnabled();
  const confirmed = n?.confirmed?.length ? n.confirmed[n.confirmed.length - 1] : undefined;

  return (
    <div className="note-page">
      <DocumentHeader modes={MARKDOWN_MODES} mode={mode} label="Note view" onMode={(v) => updateTab(tab.id, { mode: v })}
        top={<>
          <span className="eyebrow">{n?.type ?? "note"}</span>
          <span className="fill" />
          {n?.status === "active" && !editing && (
            <>
              <button className="text" onClick={() => still.mutate()} disabled={still.isPending} title="Confirm this note still holds (pushes its review date out)">
                <Check size="1.15em" aria-hidden />Still true
              </button>
              <button className="primary" onClick={() => { useSessionDraft.getState().addContext(refId); startSession(); }}>
                <Play size="1.15em" aria-hidden />Use in agent session
              </button>
            </>
          )}
          {pinOn && n?.status === "active" && !editing && (
            <button className={`text ${n.pinned ? "on" : ""}`} aria-pressed={!!n.pinned} onClick={() => pin.mutate(!n.pinned)} disabled={pin.isPending}
              title={n.pinned ? "Pinned: automatic maintenance never retires this note. Click to unpin." : "Pin: stop automatic maintenance from retiring this note"}>
              {n.pinned ? <PinOff size="1.15em" aria-hidden /> : <Pin size="1.15em" aria-hidden />}{n.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {ruleOn && ruleAllowed(n?.type) && n?.status === "active" && !editing && (
            <button className={`text ${n.rule ? "on" : ""}`} aria-pressed={!!n.rule} onClick={() => rule.mutate(!n.rule)} disabled={rule.isPending}
              title={n.rule ? "Rule: shown in full at every session start. Click to remove the rule." : "Make rule: show this note in full at every session start"}>
              <ScrollText size="1.15em" aria-hidden />{n.rule ? "Remove rule" : "Make rule"}
            </button>
          )}
          {viewsOn && n && !editing && <DashboardToggle refId={refId} title={n.title} />}
          <NoteMenu refId={refId} paper={{ white, flip: () => updateTab(tab.id, { paper: !white }) }} />
        </>}>
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
      </DocumentHeader>
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
