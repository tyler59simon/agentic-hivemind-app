// Lazy-loaded standalone Mermaid (.mmd / .mermaid) viewer and split editor.
// Reuses Hivemind's strict Mermaid renderer and link-click interception.
import { Copy, Download } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { classify } from "../../lib/errors";
import { documentIsDark, onDocumentLook } from "../../lib/paper";
import { diagramClick, renderMermaid } from "../../ui/Mermaid";
import { PanZoomViewport } from "../../ui/PanZoomViewport";
import { toast } from "../../ui/toast";
import { CodeEditor } from "../editor/CodeEditor";
import { saveCopy } from "../notes/actions";
import { copyLater } from "../../lib/platform";
import { rasterizeSvgToPng } from "../svg/svg";
import { splitKeyShare } from "../../lib/nudge";

export interface MermaidEditorProps {
  doc: string;
  docVersion: number;
  mode: "split" | "preview";
  readOnly: boolean;
  fileName: string;
  tabId: string;
  language?: string;
  onChange: (text: string) => void;
  onSave: () => void;
  titles: () => string[];
  onOpenLink: (target: string, split: boolean) => void;
  reveal?: { line: number; col?: number; at: number } | null;
}

export default function MermaidEditor(props: MermaidEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const splitHost = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [ratio, setRatio] = useState(0.45);
  const [dark, setDark] = useState<boolean | null>(null);
  const [debounced, setDebounced] = useState(props.doc);
  const [result, setResult] = useState<{ svg: string | null; error: string | null }>({ svg: null, error: null });
  const [lastSvg, setLastSvg] = useState<string | null>(null);

  useLayoutEffect(() => {
    const sync = () => setDark(documentIsDark(host.current));
    sync();
    return onDocumentLook(sync);
  }, []);

  useEffect(() => {
    if (props.mode === "preview") {
      setDebounced(props.doc);
      return;
    }
    const t = setTimeout(() => setDebounced(props.doc), 300);
    return () => clearTimeout(t);
  }, [props.doc, props.mode]);

  useEffect(() => {
    if (dark === null) return;
    if (!debounced.trim()) {
      setResult({ svg: null, error: null });
      setLastSvg(null);
      return;
    }
    let live = true;
    void renderMermaid(debounced, dark).then((res) => {
      if (!live) return;
      if (res.ok) {
        setResult({ svg: res.svg, error: null });
        setLastSvg(res.svg);
      } else {
        setResult({ svg: null, error: res.error });
      }
    });
    return () => { live = false; };
  }, [debounced, dark]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !splitHost.current) return;
      const box = splitHost.current.getBoundingClientRect();
      if (box.width <= 0) return;
      setRatio(Math.min(0.8, Math.max(0.2, (e.clientX - box.left) / box.width)));
    };
    const up = () => { dragging.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const currentSvg = result.svg ?? lastSvg;
  const stale = !!result.error && !!lastSvg;

  const copySvg = async () => {
    if (!currentSvg) return;
    try {
      await navigator.clipboard.writeText(currentSvg);
      toast("SVG copied to clipboard");
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };

  const exportSvg = () => {
    if (!currentSvg) return;
    const svgName = `${props.fileName.replace(/\.(mmd|mermaid)$/i, "")}.svg`;
    void saveCopy(currentSvg, svgName).catch((e) => toast(classify(e).message, "error"));
  };

  const copyPng = async () => {
    if (!currentSvg) return;
    try {
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
        await copyLater("image/png", rasterizeSvgToPng(currentSvg));
        toast("PNG copied to clipboard");
      } else {
        toast("Clipboard image copy is not available here", "warn");
      }
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };

  const preview = (
    <div className="diagram-preview-pane">
      {result.error && <div className="banner warn note-banner">Mermaid syntax error: {result.error}</div>}
      <PanZoomViewport
        fitKey={`${props.docVersion}:${currentSvg ? 1 : 0}`}
        actions={
          <>
            <button type="button" onClick={() => void copySvg()} disabled={!currentSvg} title="Copy rendered SVG markup">
              <Copy size="0.95em" aria-hidden /> Copy SVG
            </button>
            <button type="button" onClick={exportSvg} disabled={!currentSvg} title="Save rendered SVG as a file">
              <Download size="0.95em" aria-hidden /> Save SVG…
            </button>
            <button type="button" onClick={() => void copyPng()} disabled={!currentSvg} title="Copy rendered PNG to clipboard">
              Copy PNG
            </button>
          </>
        }
      >
        {currentSvg ? (
          <div
            className={`mermaid-diagram${stale ? " stale-preview" : ""}`}
            onClickCapture={(e) => diagramClick(e.nativeEvent)}
            dangerouslySetInnerHTML={{ __html: currentSvg }}
          />
        ) : (
          <div className="center muted">{debounced.trim() ? "Rendering diagram…" : "Write a Mermaid diagram to preview it."}</div>
        )}
      </PanZoomViewport>
    </div>
  );

  if (props.mode === "preview") return <div className="diagram-editor" ref={host}>{preview}</div>;

  return (
    <div className="diagram-editor diagram-split" ref={(el) => { host.current = el; splitHost.current = el; }}>
      <div className="diagram-source-pane" style={{ flexBasis: `${ratio * 100}%` }}>
        <CodeEditor
          doc={props.doc}
          docVersion={props.docVersion}
          follow
          language="text"
          live={false}
          readOnly={props.readOnly}
          lineNumbers
          onChange={props.onChange}
          onSave={props.onSave}
          titles={props.titles}
          onOpenLink={props.onOpenLink}
          reveal={props.reveal}
          power={{ id: props.tabId, fileName: props.fileName, language: props.language, on: true }}
        />
      </div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize source and preview"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        onKeyDown={(e) => { const next = splitKeyShare(e.key, ratio); if (next !== null) { e.preventDefault(); setRatio(next); } }}
        onPointerDown={(e) => { if (e.button === 0) dragging.current = true; }}
      />
      <div className="diagram-preview-wrap" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {preview}
      </div>
    </div>
  );
}
