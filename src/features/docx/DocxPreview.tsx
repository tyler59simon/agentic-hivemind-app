// Lazy-loaded high-fidelity `.docx` layout preview using `docx-preview` directly into the DOM (zero iframes).
// Uses `useBase64URL: true` so embedded Word images render via `data:` URIs under Hivemind's strict CSP.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { rawDocx } from "../../lib/docx";
import { classify } from "../../lib/errors";
import { scrollBehavior } from "../../lib/motion";

export interface DocxPreviewProps {
  file: FileRef;
  /** Bumped on every save/reload so layout preview refreshes from disk. */
  version: number;
  dirty: boolean;
}

const ZOOMS = [0.75, 1, 1.25, 1.5];

export default function DocxPreview({ file, version, dirty }: DocxPreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const styleHost = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [bytes, { renderAsync }] = await Promise.all([rawDocx(file.notebook, file.path), import("docx-preview")]);
        if (!live || !container.current || !styleHost.current) return;
        container.current.innerHTML = "";
        styleHost.current.innerHTML = "";
        await renderAsync(bytes, container.current, styleHost.current, {
          className: "docx-rendered",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          useBase64URL: true,
        });
        if (live) setLoading(false);
      } catch (e) {
        if (live) {
          setError(classify(e).message);
          setLoading(false);
        }
      }
    })();
    return () => { live = false; };
  }, [file.notebook, file.path, version]);

  return (
    <div className="docx-preview-shell">
      {dirty && (
        <div className="banner note-banner">
          Showing the last saved `.docx` layout on disk. Press Ctrl+S to update the layout preview with your edits.
        </div>
      )}
      <div className="docx-preview-bar" role="toolbar" aria-label="Document preview zoom">
        {ZOOMS.map((z) => (
          <button key={z} type="button" className={zoom === z ? "on" : ""} onClick={() => setZoom(z)}>
            {Math.round(z * 100)}%
          </button>
        ))}
      </div>
      {error && <div className="banner error note-banner">Could not render layout preview: {error}</div>}
      {loading && !error && <div className="center muted">Rendering Word layout…</div>}
      <div className="docx-preview-scroll">
        <div ref={styleHost} />
        <div className="docx-preview-scale" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
          <div
            ref={container}
            className="docx-preview-host"
            onClick={(e) => {
              const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
              if (!anchor) return;
              const href = anchor.getAttribute("href")?.trim() ?? "";
              e.preventDefault();
              if (!href) return;
              if (href.startsWith("#")) {
                const targetId = decodeURIComponent(href.slice(1));
                if (targetId && container.current) {
                  const target = [...container.current.querySelectorAll<HTMLElement>("[id], [name]")]
                    .find((el) => el.id === targetId || el.getAttribute("name") === targetId);
                  target?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
                }
                return;
              }
              if (/^(https?:|mailto:)/i.test(href)) {
                openUrl(href).catch(() => undefined);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
