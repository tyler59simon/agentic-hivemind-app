import { useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import { fileName, isMarkdown } from "../../lib/notebooks";
import { recentQuery, saveAs } from "../../lib/opens";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { CodeEditor } from "../editor/CodeEditor";

const none = () => [];

/** An untitled text file (NS-1B). The first save asks where; the tab then shows the saved file like any other. */
export function NewFileTab({ tab }: { tab: Tab }) {
  const [text, setText] = useState("");
  // Revealing line 1 once focuses the editor, so the new file is ready to type in.
  const [start] = useState(() => ({ line: 0, at: Date.now() }));
  const client = useQueryClient();
  const setDirty = useWorkspace((s) => s.setDirty);
  const updateTab = useWorkspace((s) => s.updateTab);
  useEffect(() => { setDirty(tab.id, text !== ""); }, [text, tab.id, setDirty]);
  const save = useCallback(async () => {
    try {
      const ref = await saveAs(text, tab.title ? `${tab.title}.txt` : "Untitled.txt");
      if (!ref) return;
      setDirty(tab.id, false);
      client.invalidateQueries({ queryKey: recentQuery().queryKey });
      updateTab(tab.id, { kind: "file", file: ref, title: fileName(ref.path), mode: isMarkdown(ref.path) ? "live" : "source" });
    } catch (e) {
      toast(classify(e).message, "error");
    }
  }, [text, tab.id, tab.title, client, setDirty, updateTab]);
  return (
    <div className="note-page file-page">
      <header className="note-header">
        <div className="note-top">
          <span className="eyebrow">New text file</span>
          <h1>{tab.title || "Untitled"}</h1>
          <span className="fill" />
          <button className="primary" onClick={() => void save()} title="Save as (Ctrl+S)"><Save size="1.1em" aria-hidden />Save as…</button>
        </div>
      </header>
      <div className="note file-editor">
        <CodeEditor doc={text} docVersion={0} language="text" live={false} readOnly={false} lineNumbers onChange={setText}
          onSave={() => void save()} titles={none} onOpenLink={() => {}} placeholder="Start typing…" reveal={start} />
      </div>
    </div>
  );
}
