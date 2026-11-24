import { useEffect, useState } from "react";
import { onZoomChange, zoomPercent } from "../lib/zoom";

/** Shows the window zoom for a moment after it changes (DESK-ZOOM). */
export function ZoomBadge() {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onZoomChange((zoom) => {
      setShown(zoom);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(null), 1500);
    });
    return () => { stop(); clearTimeout(timer); };
  }, []);
  return shown === null ? null : <div className="zoom-badge" role="status">Zoom {zoomPercent(shown)}</div>;
}
