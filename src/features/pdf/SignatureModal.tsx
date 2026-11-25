// Compact signature modal returning a transparent PNG data URL: drawn with a pointer, or typed (WCAG 2.5.7: a way that needs no dragging).
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../ui/Modal";

/** The typed signature's font: a script face that ships with Windows and macOS, then italic Georgia. The app bundles no script font. */
export const SIGNATURE_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", Georgia, serif';
const INK = "#111827";

/** Clear the canvas and write `name` on it in the signature font and the ink colour of a drawing, centred, as large as fits. */
export function drawName(c: HTMLCanvasElement, name: string) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, c.width, c.height);
  const text = name.trim();
  if (!text) return;
  let size = 84;
  const font = (px: number) => `italic ${px}px ${SIGNATURE_FONT}`;
  for (; size > 16; size -= 4) {
    ctx.font = font(size);
    if (ctx.measureText(text).width <= c.width - 40) break;
  }
  ctx.font = font(size);
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
}

type Way = "draw" | "type";

export function SignatureModal({ onClose, onApply }: { onClose: () => void; onApply: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [way, setWay] = useState<Way>("draw");
  const [name, setName] = useState("");

  // Typing draws the name on the canvas as the person types; leaving it for Draw gives a blank pad.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (way === "type") drawName(c, name);
    else { c.getContext("2d")?.clearRect(0, 0, c.width, c.height); setHasInk(false); }
  }, [way, name]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvasRef.current!.width, y: ((e.clientY - r.top) / r.height) * canvasRef.current!.height };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (way !== "draw") return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    canvasRef.current!.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setHasInk(true);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const onUp = () => { drawing.current = false; };

  const clear = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    setName("");
  };

  const ready = way === "draw" ? hasInk : !!name.trim();
  const save = () => {
    const c = canvasRef.current;
    if (!c || !ready) return;
    onApply(c.toDataURL("image/png"));
  };

  return (
    <Modal title="Add signature" onClose={onClose}>
      <div role="radiogroup" aria-label="How to make the signature" className="pdf-sig-ways">
        {(["draw", "type"] as const).map((w) => (
          <label key={w} className="check">
            <input type="radio" name="signature-way" value={w} checked={way === w} onChange={() => setWay(w)} />
            {w === "draw" ? "Draw" : "Type"}
          </label>
        ))}
      </div>
      {way === "draw"
        ? <p className="muted small">Draw your signature below, then click Place signature to stamp it onto the current page. To use the keyboard instead, choose Type.</p>
        : (
          <label className="field"><span>Your name</span>
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
          </label>
        )}
      <canvas
        ref={canvasRef}
        width={480}
        height={180}
        className={`pdf-sig-canvas${way === "type" ? " typed" : ""}`}
        role="img"
        aria-label={way === "draw" ? "Signature pad, drawn with a pointer" : name.trim() ? `Signature preview: ${name.trim()}` : "Signature preview, empty"}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="actions">
        <button type="button" onClick={clear}>Clear</button>
        <span className="fill" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={!ready} onClick={save}>Place signature</button>
      </div>
    </Modal>
  );
}
