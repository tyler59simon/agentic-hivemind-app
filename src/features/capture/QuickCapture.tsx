import { useQuery } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { classify, type Problem } from "../../lib/errors";
import { capture, domains, NOTE_TYPES, projects, showMain, taxonomy, type CapturePayload, type NoteType } from "../../lib/lm";
import { defaultTags, HEADINGS } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";
import { prefs } from "../../lib/prefs";
import { TagPicker } from "../editor/PropertiesForm";
import { mergeTags } from "../projects/wizard";

/** The note body from the quick form: a summary, plus details as bullets. */
export function captureBody(summary: string, details: string): string {
  const bullets = details.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (/^[-*+]\s/.test(l) ? l : `- ${l}`));
  return [summary.trim(), ...(bullets.length ? [`## ${HEADINGS.details}\n${bullets.join("\n")}`] : [])].join("\n\n");
}

const hide = () => getCurrentWindow().hide();

/** Open a note in the main window (it listens for this) and bring it forward. */
async function openInMain(ref: string) {
  await emit("open-note", { ref });
  await showMain();
  await hide();
}

/** The always-on-top quick capture window (global hotkey or tray). Ctrl+Enter saves, Esc hides. */
export function QuickCapture() {
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  // The capture window has its own webview and no connection store, so the feature is detected by a successful projects() call.
  const projs = useQuery({ queryKey: ["projects"], queryFn: () => projects(), retry: false });
  const active = projs.data?.projects.filter((p) => p.status === "active") ?? [];
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
  useEffect(() => { if (tax.data && !tagsTouched) setTags(defaultTags(type, tax.data.tags)); }, [tax.data, type, tagsTouched]);
  // Each time the window is shown again, start with the cursor in the title.
  useEffect(() => {
    const stop = getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (focused) titleRef.current?.focus(); });
    return () => { stop.then((u) => u()); };
  }, []);

  const reset = () => { setTitle(""); setSummary(""); setDetails(""); setProblem(null); setTagsTouched(false); };

  const save = async (extra: Partial<CapturePayload> = {}) => {
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
      <div className="row">
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as NoteType)} aria-label="Type">
          {NOTE_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      {projs.isSuccess && (
        <select value={active.some((p) => p.slug === project) ? project : ""} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">Project: none</option>
          {active.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      )}
      <input ref={titleRef} autoFocus className="title-input small-title" value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
      <textarea rows={3} value={summary} placeholder="Summary: one or two sentences" onChange={(e) => setSummary(e.target.value)} />
      <textarea rows={3} value={details} placeholder="Key details (optional, one per line)" onChange={(e) => setDetails(e.target.value)} />
      <TagPicker tags={tags} taxonomy={tax.data?.tags ?? []} onChange={(t) => { setTagsTouched(true); setTags(t); }} />
      {problem?.kind === "similar" ? (
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
