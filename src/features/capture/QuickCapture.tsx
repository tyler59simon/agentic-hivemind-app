import { useQuery, useQueryClient } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { classify, type Problem } from "../../lib/errors";
import { capture, domains, lmNotebooksQuery, projects, showMain, taxonomy, type CapturePayload, type NoteType } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { defaultTags, HEADINGS } from "../../lib/note";
import { NOT_CAPTURED, typeOptions, useNoteTypes } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { prefs, type CaptureTarget } from "../../lib/prefs";
import { Tabs } from "../../ui/Page";
import { TagPicker } from "../editor/PropertiesForm";
import { appendToPage, captureLine } from "../notes/append";
import { formatDate } from "../notes/daily";
import { ensureDaily, loadNotebookInfo } from "../notes/dailyPages";
import { mergeTags } from "../projects/wizard";

/** The note body from the quick form: a summary, plus details as bullets. */
export function captureBody(summary: string, details: string): string {
  const bullets = details.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (/^[-*+]\s/.test(l) ? l : `- ${l}`));
  return [summary.trim(), ...(bullets.length ? [`## ${HEADINGS.details}\n${bullets.join("\n")}`] : [])].join("\n\n");
}

const hide = () => getCurrentWindow().hide();

/** Today's page keeps what the window captures under this heading. */
export const CAPTURE_HEADING = "## Captured";

const TARGETS: { id: CaptureTarget["kind"]; label: string }[] = [
  { id: "memory", label: "Memory note" }, { id: "today", label: "Today's page" }, { id: "inbox", label: "Inbox" },
];

/** Add what the form holds to a page of a notebook (NS-7A): under `## Captured` on today's page, which is made from the daily
 *  template when it is not there yet, or at the end of the notebook's inbox page. Returns the page it went to. */
export async function captureToPage(kind: "today" | "inbox", notebook: string, form: { title: string; summary: string; details: string }, now = new Date()): Promise<string> {
  let path: string;
  let heading: string | null = null;
  if (kind === "today") {
    path = (await ensureDaily(notebook, now)).path;
    heading = CAPTURE_HEADING;
  } else {
    path = (await loadNotebookInfo(notebook)).settings.inbox;
  }
  const when = formatDate(now, kind === "today" ? "HH:mm" : "YYYY-MM-DD HH:mm");
  await appendToPage(notebook, path, heading, captureLine(when, form.title, form.summary, form.details));
  return path;
}

/** Open a note in the main window (it listens for this) and bring it forward. */
async function openInMain(ref: string) {
  await emit("open-note", { ref });
  await showMain();
  await hide();
}

/** The always-on-top quick capture window (global hotkey or tray). Ctrl+Enter saves, Esc hides. */
export function QuickCapture() {
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  // The capture window has its own webview and no connection store, so the feature is detected by a successful projects() call.
  const projs = useQuery({ queryKey: ["projects"], queryFn: () => projects(), retry: false });
  const active = projs.data?.projects.filter((p) => p.status === "active") ?? [];
  // Custom note types the same way: asked for, with the built-ins when Living Memory has no `types` command.
  const types = useNoteTypes(true);
  const [target, setTarget] = useState<CaptureTarget>(() => prefs.captureTarget());
  // Notebooks the same way as the main window asks for them; a Living Memory without notebook pages just has none.
  const folderBooks = useQuery({ ...notebooksQuery(), retry: false });
  const lmBooks = useQuery({ ...lmNotebooksQuery(), retry: false });
  const books = [
    ...(folderBooks.data ?? []).map((n) => ({ id: n.id, label: n.title })),
    ...(lmBooks.data?.notebooks ?? []).map((n) => ({ id: lmContainer(n.domain, n.notebook), label: `${n.domain} · ${n.title}` })),
  ];
  const notebook = books.some((b) => b.id === target.notebook) ? target.notebook : books[0]?.id ?? "";
  const toPage = target.kind !== "memory";
  const [project, setProject] = useState(prefs.captureProject() ?? "");
  const [domain, setDomain] = useState(prefs.captureDomain() ?? "");
  const [type, setType] = useState<NoteType>("knowledge");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagsTouched, setTagsTouched] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!domain && known.data) setDomain(known.data.domains.find((d) => d.bound)?.name ?? known.data.domains[0]?.name ?? "");
  }, [known.data, domain]);
  useEffect(() => { if (tax.data && !tagsTouched) setTags(defaultTags(type, tax.data.tags, types.def(type))); }, [tax.data, type, tagsTouched, types]);
  // Each time the window is shown again, start with the cursor in the title. The window is hidden, not closed, and has its
  // own query cache, so note types created, edited or retired in the main window meanwhile are fetched again.
  useEffect(() => {
    const stop = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      titleRef.current?.focus();
      client.invalidateQueries({ queryKey: ["types"] });
    });
    return () => { stop.then((u) => u()); };
  }, [client]);

  const reset = () => { setTitle(""); setSummary(""); setDetails(""); setProblem(null); setTagsTouched(false); };

  const saveToPage = async () => {
    if (!notebook) { setProblem({ kind: "other", message: "Pick a notebook. Add one on the Notes page first if there is none." }); return; }
    if (!title.trim() && !summary.trim()) { setProblem({ kind: "other", message: "Write something to capture." }); return; }
    setBusy(true);
    setProblem(null);
    try {
      const path = await captureToPage(target.kind as "today" | "inbox", notebook, { title, summary, details });
      prefs.setCaptureTarget({ kind: target.kind, notebook });
      // Rust's write is not seen by the watcher: the main window refreshes the page if it has it open.
      await emit("page-appended", { notebook, path }).catch(() => {});
      setSaved(target.kind === "today" ? "Added to today's page." : "Added to the inbox.");
      reset();
      setTimeout(() => { setSaved(null); hide(); }, 900);
    } catch (e) { setProblem(classify(e)); }
    finally { setBusy(false); }
  };

  const save = async (extra: Partial<CapturePayload> = {}) => {
    if (toPage) { await saveToPage(); return; }
    if (!title.trim() || !summary.trim() || !domain) {
      setProblem({ kind: "other", message: "A domain, a title and a summary are needed." });
      return;
    }
    const chosen = active.find((p) => p.slug === project);
    setBusy(true);
    setProblem(null);
    try {
      const r = await capture(domain, { title: title.trim(), body: captureBody(summary, details), tags: mergeTags(tags, chosen ? [chosen.tag] : []), type, ...extra });
      recordOperation(r.operation_id);
      prefs.setCaptureDomain(domain);
      if (projs.isSuccess) prefs.setCaptureProject(project);
      setSaved(r.status === "created" ? `Saved “${title.trim()}”.` : "Living Memory already had this note.");
      reset();
      setTimeout(() => { setSaved(null); hide(); }, 900);
    } catch (e) { setProblem(classify(e)); }
    finally { setBusy(false); }
  };

  return (
    <main className="quick-capture" onKeyDown={(e) => {
      if (e.key === "Escape") hide();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    }}>
      <Tabs items={TARGETS} value={target.kind} label="Capture to" onChange={(kind) => { setTarget({ kind, notebook }); setProblem(null); }} />
      {toPage && (
        books.length > 0 ? (
          <select value={notebook} onChange={(e) => setTarget({ kind: target.kind, notebook: e.target.value })} aria-label="Notebook">
            {books.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        ) : <p className="muted small">{folderBooks.isLoading || lmBooks.isLoading ? "Looking for notebooks…" : "There is no notebook yet. Add one on the Notes page."}</p>
      )}
      {!toPage && (
        <div className="row">
          <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
            {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value as NoteType)} aria-label="Type">
            {typeOptions(types.active, type, NOT_CAPTURED).map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      )}
      {!toPage && projs.isSuccess && (
        <select value={active.some((p) => p.slug === project) ? project : ""} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">Project: none</option>
          {active.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      )}
      <input ref={titleRef} autoFocus className="title-input small-title" value={title} placeholder={toPage ? "Title (optional)" : "Title"} onChange={(e) => setTitle(e.target.value)} />
      <textarea rows={3} value={summary} placeholder={toPage ? "What to capture" : "Summary: one or two sentences"} onChange={(e) => setSummary(e.target.value)} />
      <textarea rows={3} value={details} placeholder={toPage ? "Details (optional, one per line)" : "Key details (optional, one per line)"} onChange={(e) => setDetails(e.target.value)} />
      {!toPage && <TagPicker tags={tags} taxonomy={tax.data?.tags ?? []} onChange={(t) => { setTagsTouched(true); setTags(t); }} />}
      {!toPage && problem?.kind === "similar" ? (
        <div className="banner warn">
          A similar note exists: “{problem.title}”.
          <div className="actions">
            {problem.ref && <button onClick={() => openInMain(problem.ref!)}>Open it in Hivemind</button>}
            <button className="primary" onClick={() => save({ allow_similar: true })}>Save anyway</button>
          </div>
        </div>
      ) : problem && <div className="banner error">{problem.message}</div>}
      {saved && <div className="banner">{saved}</div>}
      <div className="actions">
        <span className="muted small">Ctrl+Enter saves · Esc hides</span>
        <span className="tabbar-fill" />
        <button onClick={() => hide()}>Close</button>
        <button className="primary" disabled={busy} onClick={() => save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </main>
  );
}
