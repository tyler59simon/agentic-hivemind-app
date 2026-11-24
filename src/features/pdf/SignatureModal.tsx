// Compact pointer-event signature pad modal returning a transparent PNG data URL.
import { useRef, useState } from "react";
import { Modal } from "../../ui/Modal";

export function SignatureModal({ onClose, onApply }: { onClose: () => void; onApply: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvasRef.current!.width, y: ((e.clientY - r.top) / r.height) * canvasRef.current!.height };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    canvasRef.current!.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.strokeStyle = "#111827";
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
  };

  const save = () => {
    const c = canvasRef.current;
    if (!c || !hasInk) return;
    onApply(c.toDataURL("image/png"));
  };

  return (
    <Modal title="Draw signature" onClose={onClose}>
      <p className="muted small">Draw your signature below, then click Place signature to stamp it onto the current page.</p>
      <canvas
        ref={canvasRef}
        width={480}
        height={180}
        className="pdf-sig-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="actions">
        <button type="button" onClick={clear}>Clear</button>
        <span className="fill" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={!hasInk} onClick={save}>Place signature</button>
      </div>
    </Modal>
  );
}
