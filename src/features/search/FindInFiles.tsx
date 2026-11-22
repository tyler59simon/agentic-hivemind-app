// Find in files and replace in files (NS-6B): a tab that searches a notebook or a folder, lists the matches by file, and
// can replace them. Replace first shows every change with a tick box; it writes only the ticked ones, skips a file that
// changed since the preview or has unsaved edits in a tab, and Undo all puts the files back.
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Regex } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { isUnsaved } from "../../documents/session";
import { refresh, useDocuments } from "../../documents/store";
import { classify } from "../../lib/errors";
import { globList, replaceApply, replacePreview, replaceUndo, type Applied, type FindQuery, type FindScope, type Preview } from "../../lib/findInFiles";
import { otherFolders } from "../../lib/folders";
import { notebooksQuery } from "../../lib/notebooks";
import { isLoose } from "../../lib/opens";
import { toast } from "../../ui/toast";
import { activeTab, useWorkspace } from "../../workspace/store";
import { markPattern, pieces } from "../bigfile/BigFileView";
import { openPage } from "../notes/actions";

/** The scope a request to find in files asks for; `tick` makes a second request for the same scope count. */
interface Launch { scope: FindScope | null; tick: number }
const useLaunch = create<Launch>(() => ({ scope: null, tick: 0 }));

/** Open the find in files tab, on `scope` when given (a notebook's or folder's context menu). */
export function openFindInFiles(scope?: FindScope) {
  useLaunch.setState((s) => ({ scope: scope ?? null, tick: s.tick + 1 }));
  useWorkspace.getState().openTab({ kind: "find", title: "Find in files" });
}

/** A scope as the select holds it. */
const scopeValue = (s: FindScope) => (s.notebook ? `nb:${s.notebook}` : s.folder ? `folder:${s.folder}` : "");
const scopeOf = (value: string, sub?: string): FindScope => (value.startsWith("nb:") ? { notebook: value.slice(3), ...(sub ? { sub } : {}) } : value.startsWith("folder:") ? { folder: value.slice(7) } : {});

/** The pages with unsaved edits in a tab, as paths of `notebook`. */
function unsavedIn(notebook: string | undefined): string[] {
  if (!notebook) return [];
  const { docs, refs } = useDocuments.getState();
  return Object.entries(refs).filter(([key, ref]) => ref.notebook === notebook && isUnsaved(docs[key])).map(([, ref]) => ref.path);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** `text` with the matches of `mark` marked. */
function Marked({ text, mark }: { text: string; mark: RegExp | null }) {
  return <>{pieces(text, mark).map((p, i) => (p.on ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

export function FindInFilesTab() {
  const notebooks = useQuery(notebooksQuery());
  const folders = useQuery({ queryKey: ["settings", "other-folders"], queryFn: otherFolders });
  const launch = useLaunch();
  const current = useWorkspace((s) => { const t = activeTab(s); return t?.kind === "file" && t.file && !isLoose(t.file) && !t.file.notebook.startsWith("lm:") ? t.file.notebook : ""; });
  const [where, setWhere] = useState(() => (launch.scope ? scopeValue(launch.scope) : ""));
  const [sub, setSub] = useState(launch.scope?.sub ?? "");
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [word, setWord] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<Preview | null>(null);
  /** What the result was searched with: the replace button writes this, not what the boxes say now. */
  const [searched, setSearched] = useState<{ scope: FindScope; query: FindQuery; replacement: string; replaced: boolean } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ticked, setTicked] = useState<Record<string, Set<number>>>({});
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Applied | null>(null);
  const [undone, setUndone] = useState<Applied | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A request from a context menu or the palette picks its scope, also when the tab is already open.
  useEffect(() => {
    if (launch.scope) { setWhere(scopeValue(launch.scope)); setSub(launch.scope.sub ?? ""); }
    input.current?.focus();
  }, [launch.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // With nothing asked for, the notebook of the page being read, else the first one.
  const effective = where || (current ? `nb:${current}` : notebooks.data?.[0] ? `nb:${notebooks.data[0].id}` : "");
  const scope = scopeOf(effective, sub);

  const query: FindQuery = { pattern, regex, case: caseSensitive, word, include: globList(include), exclude: globList(exclude) };
  const touch = () => setStale(true);

  const run = async () => {
    if (!pattern || !effective) return;
    setBusy(true);
    setError("");
    setApplied(null);
    setUndone(null);
    try {
      const wanted = replacing ? replacement : null;
      const got = await replacePreview(scope, query, wanted);
      setResult(got);
      setSearched({ scope, query, replacement, replaced: replacing });
      setStale(false);
      setTicked(Object.fromEntries(got.files.map((f) => [f.path, new Set(f.hunks.map((h) => h.index))])));
      setFolded(new Set());
    } catch (e) {
      setError(classify(e).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = useMemo(() => (result?.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256, hunks: [...(ticked[f.path] ?? [])] })).filter((f) => f.hunks.length), [result, ticked]);
  const total = chosen.reduce((n, f) => n + f.hunks.length, 0);

  const afterWrite = (done: Applied, scoped: FindScope) => {
    if (scoped.notebook) void refresh(scoped.notebook, done.done.map((d) => d.path));
  };
  const apply = async () => {
    if (!searched || !chosen.length) return;
    setBusy(true);
    setError("");
    try {
      const done = await replaceApply(searched.scope, searched.query, searched.replacement, chosen, unsavedIn(searched.scope.notebook));
      setApplied(done);
      setUndone(null);
      // What was found is out of date now.
      setResult(null);
      afterWrite(done, searched.scope);
    } catch (e) {
      setError(classify(e).message);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!applied?.undo || !searched) return;
    setBusy(true);
    try {
      const back = await replaceUndo(applied.undo, unsavedIn(searched.scope.notebook));
      setUndone(back);
      setApplied({ ...applied, undo: null });
      afterWrite(back, searched.scope);
      toast(`Put back ${plural(back.done.length, "file")}${back.skipped.length ? `; ${back.skipped.length} skipped` : ""}`);
    } catch (e) {
      setError(classify(e).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleFile = (path: string, all: number[]) => setTicked((t) => ({ ...t, [path]: t[path]?.size === all.length ? new Set() : new Set(all) }));
  const toggleHunk = (path: string, index: number) => setTicked((t) => {
    const next = new Set(t[path] ?? []);
    if (next.has(index)) next.delete(index); else next.add(index);
    return { ...t, [path]: next };
  });
  const fold = (path: string) => setFolded((f) => { const n = new Set(f); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const open = (path: string, line: number) => {
    if (!searched?.scope.notebook) return;
    openPage({ notebook: searched.scope.notebook, path });
    const tab = activeTab(useWorkspace.getState());
    if (tab) useWorkspace.getState().revealLine(tab.id, line);
  };

  const mark = useMemo(() => markPattern(searched?.query.pattern ?? "", !!searched?.query.regex, !!searched?.query.case), [searched]);
  const replaceMode = !!searched?.replaced && result !== null && !stale;

  return (
    <div className="note-page find-page">
      <header className="note-header">
        <div className="note-top"><h1>Find in files</h1></div>
      </header>
      <form className="find-form" onSubmit={(e) => { e.preventDefault(); void run(); }} aria-label="Find in files">
        <div className="find-row">
          <select aria-label="Where to search" value={effective} onChange={(e) => { setWhere(e.target.value); setSub(""); touch(); }}>
            {(notebooks.data ?? []).length > 0 && <optgroup label="Notebooks">{notebooks.data!.map((n) => <option key={n.id} value={`nb:${n.id}`}>{n.title}</option>)}</optgroup>}
            {(folders.data ?? []).length > 0 && <optgroup label="Folders">{folders.data!.map((f) => <option key={f} value={`folder:${f}`}>{f}</option>)}</optgroup>}
          </select>
          {sub && <button type="button" className="chip on" title="Only this folder of the notebook; click to search all of it" onClick={() => { setSub(""); touch(); }}>in {sub} ×</button>}
          <input ref={input} aria-label="Find" className="find-pattern" placeholder="Find" value={pattern} autoFocus onChange={(e) => { setPattern(e.target.value); touch(); }} />
          <button type="button" className={`chip${regex ? " on" : ""}`} aria-pressed={regex} aria-label="Regular expression" title="Regular expression" onClick={() => { setRegex(!regex); touch(); }}><Regex size="1em" aria-hidden /></button>
          <button type="button" className={`chip${caseSensitive ? " on" : ""}`} aria-pressed={caseSensitive} aria-label="Match case" title="Match case" onClick={() => { setCaseSensitive(!caseSensitive); touch(); }}>Aa</button>
          <button type="button" className={`chip${word ? " on" : ""}`} aria-pressed={word} aria-label="Whole word" title="Whole word" onClick={() => { setWord(!word); touch(); }}>ab</button>
          <button className="primary" type="submit" disabled={busy || !pattern || !effective}>{busy ? "Searching…" : replacing ? "Preview" : "Find"}</button>
        </div>
        <div className="find-row">
          <button type="button" className={`chip${replacing ? " on" : ""}`} aria-pressed={replacing} onClick={() => { setReplacing(!replacing); touch(); }}>Replace</button>
          {replacing && <input aria-label="Replace with" className="find-pattern" placeholder={regex ? "Replace with ($1 is the first group)" : "Replace with"} value={replacement} onChange={(e) => { setReplacement(e.target.value); touch(); }} />}
        </div>
        <div className="find-row">
          <input aria-label="Files to include" className="find-glob" placeholder="Include: *.md, docs/**" value={include} onChange={(e) => { setInclude(e.target.value); touch(); }} />
          <input aria-label="Files to exclude" className="find-glob" placeholder="Exclude: drafts/, *.log" value={exclude} onChange={(e) => { setExclude(e.target.value); touch(); }} />
        </div>
      </form>
      {error && <div className="banner error note-banner" role="alert">{error}</div>}
      <div className="find-results" aria-live="polite">
        {applied && (
          <div className="banner note-banner" role="status">
            {applied.done.length
              ? `Replaced ${plural(applied.done.reduce((n, d) => n + d.replaced, 0), "match", "matches")} in ${plural(applied.done.length, "file")}.`
              : "Nothing was replaced."}
            <div className="actions">{applied.undo && <button onClick={() => void undo()} disabled={busy}>Undo all</button>}</div>
          </div>
        )}
        {undone && <div className="banner note-banner" role="status">Put back {plural(undone.done.length, "file")}.</div>}
        {[...(applied?.skipped ?? []).map((s) => ({ ...s, from: "replace" })), ...(undone?.skipped ?? []).map((s) => ({ ...s, from: "undo" }))].length > 0 && (
          <div className="banner warn note-banner" role="status">
            <strong>Skipped</strong>
            <ul className="find-skipped">
              {(applied?.skipped ?? []).map((s) => <li key={`r-${s.path}`}><code>{s.path}</code>: {s.why}</li>)}
              {(undone?.skipped ?? []).map((s) => <li key={`u-${s.path}`}><code>{s.path}</code>: {s.why}</li>)}
            </ul>
          </div>
        )}
        {result && (
          <>
            <div className="find-summary">
              <span role="status">
                {result.matches === 0 ? "No matches" : `${plural(result.matches, "match", "matches")} in ${plural(result.files.length, "file")}`}
                {stale && <span className="muted"> (the search changed; press {replacing ? "Preview" : "Find"} again)</span>}
              </span>
              <span className="fill" />
              {replaceMode && (
                <button className="primary" disabled={busy || total === 0 || !searched} onClick={() => void apply()}>
                  Replace {plural(total, "match", "matches")} in {plural(chosen.length, "file")}
                </button>
              )}
            </div>
            {result.capped && <p className="muted small">Stopped at 10,000 matches. Narrow the search to see the rest.</p>}
            {(result.binary > 0 || result.large > 0) && (
              <p className="muted small">Left out: {[result.binary ? plural(result.binary, "binary file") : "", result.large ? `${plural(result.large, "file")} over 8 MB` : ""].filter(Boolean).join(", ")}.</p>
            )}
            {result.skipped.length > 0 && (
              <div className="banner warn note-banner">
                <strong>Cannot be changed here</strong>
                <ul className="find-skipped">{result.skipped.map((s) => <li key={s.path}><code>{s.path}</code>: {s.why}</li>)}</ul>
              </div>
            )}
            <ul className="find-files">
              {result.files.map((f) => {
                const all = f.hunks.map((h) => h.index);
                const on = ticked[f.path] ?? new Set<number>();
                const shut = folded.has(f.path);
                return (
                  <li key={f.path} className="find-file">
                    <div className="find-file-head">
                      {replaceMode && <input type="checkbox" aria-label={`Replace in ${f.path}`} checked={on.size === all.length} ref={(el) => { if (el) el.indeterminate = on.size > 0 && on.size < all.length; }} onChange={() => toggleFile(f.path, all)} />}
                      <button type="button" className="find-fold" aria-expanded={!shut} aria-label={`${shut ? "Show" : "Hide"} matches in ${f.path}`} onClick={() => fold(f.path)}>
                        {shut ? <ChevronRight size="1em" aria-hidden /> : <ChevronDown size="1em" aria-hidden />}
                      </button>
                      <span className="find-path">{f.path}</span>
                      <span className="muted small">{plural(f.matches, "match", "matches")}</span>
                    </div>
                    {!shut && (
                      <ul className="find-hunks">
                        {f.hunks.map((h) => (
                          <li key={h.index} className="find-hunk">
                            {replaceMode && <input type="checkbox" aria-label={`Replace line ${h.line} of ${f.path}`} checked={on.has(h.index)} onChange={() => toggleHunk(f.path, h.index)} />}
                            {searched?.scope.notebook && !replaceMode
                              ? <button type="button" className="find-line link" onClick={() => open(f.path, h.line)}>{h.line}</button>
                              : <span className="find-line">{h.line}</span>}
                            {replaceMode
                              ? <span className="find-diff"><span className="find-del">{h.before}</span><span className="find-add">{h.after}</span></span>
                              : <span className="find-text"><Marked text={h.before} mark={mark} /></span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
