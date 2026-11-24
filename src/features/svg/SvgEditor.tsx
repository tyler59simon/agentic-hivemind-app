// Lazy-loaded SVG viewer and split XML editor. Renders SVG exclusively inside an `<img>` data URI so untrusted
// `<script>` tags, event handlers, and external sub-resource fetches never run.
import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanZoomViewport } from "../../ui/PanZoomViewport";
import { toast } from "../../ui/toast";
import { CodeEditor } from "../editor/CodeEditor";
import { copyLater } from "../../lib/platform";
import { inspectSvg, rasterizeSvgToPng, svgToDataUrl, type SvgInfo } from "./svg";

export interface SvgEditorProps {
  doc: string;
  docVersion: number;
  mode: "preview" | "split";
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

export default function SvgEditor(props: SvgEditorProps) {
  const [debounced, setDebounced] = useState(props.doc);
  const [ratio, setRatio] = useState(0.5);
  const splitHost = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (props.mode === "preview") {
      setDebounced(props.doc);
      return;
    }
    const t = setTimeout(() => setDebounced(props.doc), 200);
    return () => clearTimeout(t);
  }, [props.doc, props.mode]);

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

  const inspected: SvgInfo = useMemo(() => inspectSvg(debounced), [debounced]);
  const [lastValid, setLastValid] = useState<{ text: string; url: string; info: Extract<SvgInfo, { ok: true }> } | null>(() => {
    const first = inspectSvg(props.doc);
    return first.ok ? { text: props.doc, url: svgToDataUrl(props.doc), info: first } : null;
  });

  useEffect(() => {
    if (inspected.ok) {
      setLastValid({ text: debounced, url: svgToDataUrl(debounced), info: inspected });
    }
  }, [debounced, inspected]);

  const activeInfo = inspected.ok ? inspected : lastValid?.info ?? null;
  const dims = activeInfo?.width && activeInfo?.height ? `${Math.round(activeInfo.width)} × ${Math.round(activeInfo.height)}` : undefined;

  const copyPng = async () => {
    const src = inspected.ok ? debounced : lastValid?.text;
    if (!src) return;
    try {
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
        await copyLater("image/png", rasterizeSvgToPng(src));
        toast("PNG copied to clipboard");
      } else {
        toast("Clipboard image copy is not available here", "warn");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const preview = (
    <div className="diagram-preview-pane">
      {!inspected.ok && <div className="banner warn note-banner">Invalid SVG XML: {inspected.error}</div>}
      <PanZoomViewport
        showBackdropToggle
        defaultBackdrop="checker"
        info={dims}
        fitKey={props.docVersion}
        actions={
          <button type="button" onClick={() => void copyPng()} disabled={!lastValid} title="Copy rendered PNG to clipboard">
            <Copy size="0.95em" aria-hidden /> Copy PNG
          </button>
        }
      >
        {lastValid ? (
          <img
            className={`svg-preview-img${inspected.ok ? "" : " stale-preview"}`}
            src={lastValid.url}
            alt={props.fileName}
            width={activeInfo?.width ?? undefined}
            height={activeInfo?.height ?? undefined}
            draggable={false}
          />
        ) : (
          <div className="center muted">Enter valid SVG XML to preview.</div>
        )}
      </PanZoomViewport>
    </div>
  );

  if (props.mode === "preview") return <div className="diagram-editor">{preview}</div>;

  return (
    <div className="diagram-editor diagram-split" ref={splitHost}>
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
          power={{ id: props.tabId, fileName: props.fileName, language: props.language ?? "XML", on: true }}
        />
      </div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize source and preview"
        onPointerDown={(e) => { if (e.button === 0) dragging.current = true; }}
      />
      <div className="diagram-preview-wrap" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {preview}
      </div>
    </div>
  );
}
