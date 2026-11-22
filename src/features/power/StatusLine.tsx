// The status line below a file's editor (NS-1B showed it; NS-6A makes each part clickable): encoding, line endings,
// indentation, language and size. Its menus reopen the file in another encoding, choose the encoding and line endings the
// next save writes, and pick the language.
import { useEffect, useMemo, useState } from "react";
import { reformat, reopenAs } from "../../documents/store";
import { isUnsaved, type DocState } from "../../documents/session";
import { classify } from "../../lib/errors";
import type { Eol } from "../../lib/notebooks";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { lineTool, runLineTool } from "./lineTools";
import { describe, detectIndent, languageList, PLAIN } from "./language";
import { editorOf } from "./registry";

/** The encodings a file can be reopened or saved in: the ones Hivemind writes back exactly (the same list as
 *  `files::encoding::EDITABLE` in Rust, which refuses any other). */
export const ENCODINGS: { name: string; label: string; bom?: boolean }[] = [
  { name: "UTF-8", label: "UTF-8" },
  { name: "UTF-8", label: "UTF-8 with BOM", bom: true },
  { name: "UTF-16LE", label: "UTF-16 LE", bom: true },
  { name: "UTF-16BE", label: "UTF-16 BE", bom: true },
  { name: "windows-1252", label: "Western (Windows-1252)" },
  { name: "ISO-8859-2", label: "Central European (ISO-8859-2)" },
  { name: "windows-1250", label: "Central European (Windows-1250)" },
  { name: "windows-1251", label: "Cyrillic (Windows-1251)" },
  { name: "KOI8-R", label: "Cyrillic (KOI8-R)" },
  { name: "windows-1253", label: "Greek (Windows-1253)" },
  { name: "Shift_JIS", label: "Japanese (Shift_JIS)" },
  { name: "EUC-JP", label: "Japanese (EUC-JP)" },
  { name: "GBK", label: "Chinese, simplified (GBK)" },
  { name: "Big5", label: "Chinese, traditional (Big5)" },
  { name: "EUC-KR", label: "Korean (EUC-KR)" },
];

const SIZE_UNITS = ["bytes", "KB", "MB"];
function size(n: number) {
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${SIZE_UNITS[i]}` : `${n} bytes`;
}
const EOL_NAMES: Record<Eol, string> = { lf: "LF", crlf: "CRLF", cr: "CR", mixed: "Mixed line endings", none: "" };

/** What an encoding is called in the status line. */
export function encodingLabel(f: { encoding: string; bom: boolean }) {
  return ENCODINGS.find((e) => e.name === f.encoding && !!e.bom === f.bom)?.label
    ?? `${ENCODINGS.find((e) => e.name === f.encoding)?.label ?? f.encoding}${f.bom ? " with BOM" : ""}`;
}

const fail = (e: unknown) => toast(classify(e).message, "error");

/** The language shown for a file: the override, else the one its name gives. */
function useLanguageName(fileName: string, override: string | undefined, markdown: boolean) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (markdown) return;
    let stale = false;
    describe(fileName, override).then((d) => { if (!stale) setName(d?.name ?? PLAIN); }, () => { if (!stale) setName(PLAIN); });
    return () => { stale = true; };
  }, [fileName, override, markdown]);
  return markdown ? "Markdown" : name ?? "";
}

export function StatusLine({ doc, docKey, tabId, fileName, markdown, language, onLanguage, living }: {
  doc: DocState; docKey: string; tabId: string; fileName: string; markdown: boolean; language?: string; onLanguage: (name: string | undefined) => void;
  /** A Living Memory page is always UTF-8 with its own line endings: no encoding actions. */
  living?: boolean;
}) {
  const [names, setNames] = useState<string[]>([]);
  const languageName = useLanguageName(fileName, language, markdown);
  useEffect(() => {
    if (!markdown) void languageList().then((all) => setNames(all.map((l) => l.name).sort((a, b) => a.localeCompare(b))), () => {});
  }, [markdown]);
  const indent = useMemo(() => detectIndent(doc.text), [doc.text]);
  if (!doc.base) return null;
  const f = doc.base.format;
  const binary = doc.base.binary;
  const encoding = binary ? "Not text" : `${encodingLabel(f)}${f.confidence === "guess" ? " (guessed)" : ""}${doc.convert ? " (converted, not saved yet)" : ""}${doc.reformat && !doc.convert ? " (not saved yet)" : ""}`;
  if (living) return <div className="file-status muted">{[encoding, EOL_NAMES[f.eol], size(doc.base.stamp.size)].filter(Boolean).join(" · ")}</div>;
  const canReopen = (doc.status === "clean" || doc.status === "readOnly") && !doc.kept;
  const whyNot = isUnsaved(doc) ? "Save or discard your edits to reopen the file in another encoding." : doc.kept ? "Discard the draft kept beside this page first." : "This file cannot be reopened now.";
  // The next save can write another encoding or line ending for a page that is open for editing; a mixed-endings page
  // is also offered a choice, which makes it editable.
  const canChange = !binary && (doc.status === "clean" || doc.status === "dirty" || (doc.status === "readOnly" && !!doc.base.chooseEol && !doc.kept));
  const editor = editorOf(tabId);
  const reopen = (enc: string) => reopenAs(docKey, enc).then((done) => { if (!done) toast("Reopen stopped: you typed while the file was read, so nothing changed.", "warn"); }, fail);
  const indentTool = (id: string) => { const v = editorOf(tabId), t = lineTool(id); if (v && t && !runLineTool(v, t)) toast(`${t.label}: nothing to change.`); v?.focus(); };

  return (
    <div className="file-status muted">
      <Menu up label="Encoding" align="left" className="status-menu" button={encoding}>
        {(close) => (
          <>
            <li role="none"><div className="menu-group muted">Reopen with encoding</div></li>
            {!canReopen && <li role="none"><div className="menu-note muted">{whyNot}</div></li>}
            {ENCODINGS.filter((e) => !e.bom || e.name !== "UTF-8").map((e) => (
              <li key={`r-${e.name}`}><button role="menuitem" disabled={!canReopen} onClick={() => { close(); void reopen(e.name); }}>{e.label}</button></li>
            ))}
            {canChange && (
              <>
                <li role="none"><div className="menu-group muted">Convert to (written when you save)</div></li>
                {ENCODINGS.map((e) => (
                  <li key={`c-${e.name}-${!!e.bom}`}>
                    <button role="menuitem" aria-current={!!e.bom === f.bom && e.name === f.encoding} onClick={() => { close(); reformat(docKey, { encoding: e.name, bom: !!e.bom }); }}>{e.label}</button>
                  </li>
                ))}
              </>
            )}
          </>
        )}
      </Menu>
      {!binary && (
        <>
          <span aria-hidden> · </span>
          <Menu up label="Line endings" align="left" className="status-menu" button={`${EOL_NAMES[f.eol] || "No line breaks"}${doc.reformat && f.eol !== doc.reformat.from.eol ? " (not saved yet)" : ""}`}>
            {(close) => (
              <>
                {f.eol === "mixed" && <li role="none"><div className="menu-note muted">This file mixes line-ending styles. Choose one to edit it.</div></li>}
                {(["lf", "crlf"] as const).map((eol) => (
                  <li key={eol}><button role="menuitem" disabled={!canChange} aria-current={f.eol === eol} onClick={() => { close(); reformat(docKey, { eol }); }}>
                    {f.eol === "mixed" ? `Use ${EOL_NAMES[eol]} and edit` : EOL_NAMES[eol]}
                  </button></li>
                ))}
              </>
            )}
          </Menu>
          <span aria-hidden> · </span>
          <Menu up label="Indentation" align="left" className="status-menu" button={indent}>
            {(close) => (
              <>
                <li><button role="menuitem" disabled={!editor} onClick={() => { close(); indentTool("tabs-to-spaces"); }}>Tabs to spaces</button></li>
                <li><button role="menuitem" disabled={!editor} onClick={() => { close(); indentTool("spaces-to-tabs"); }}>Indentation spaces to tabs</button></li>
                <li role="none"><div className="menu-note muted">Applies to the selection, or to the whole file when nothing is selected.</div></li>
              </>
            )}
          </Menu>
          <span aria-hidden> · </span>
          {markdown
            ? <span>{languageName}</span>
            : (
              <Menu up label="Language" align="left" className="status-menu" button={languageName || "Language"}>
                {(close) => (
                  <>
                    <li><button role="menuitem" aria-current={!language} onClick={() => { close(); onLanguage(undefined); }}>Choose from the file name</button></li>
                    <li><button role="menuitem" aria-current={language === PLAIN} onClick={() => { close(); onLanguage(PLAIN); }}>{PLAIN}</button></li>
                    {names.map((n) => <li key={n}><button role="menuitem" aria-current={language === n} onClick={() => { close(); onLanguage(n); }}>{n}</button></li>)}
                  </>
                )}
              </Menu>
            )}
          <span aria-hidden> · </span>
        </>
      )}
      <span>{size(doc.base.stamp.size)}</span>
    </div>
  );
}
