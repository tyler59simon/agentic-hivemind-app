import { useEffect, useRef } from "react";
import type { Engine } from "../../lib/agent";
import type { StartMode } from "../../lib/term";
import { swallow } from "./keys";
import * as registry from "./registry";

/** One terminal's screen. The xterm instance lives in the registry; this component only gives it a place. */
export function TerminalView({ id, sessionId, engine, start, label }: {
  id: string; sessionId: string | null; engine: Engine; start: StartMode | null; label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = registry.useLive(id);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    registry.ensure(id, { sessionId, engine, start });
    registry.mount(id, el);
    // xterm listens on its own textarea, inside this element, so this runs after xterm and before the app's window listeners.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (swallow(e)) e.preventDefault();
    };
    el.addEventListener("keydown", onKey);
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => registry.refit(id), 80);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      el.removeEventListener("keydown", onKey);
    };
    // The session, engine and start mode are read once, when the terminal is first created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <>
      <div className="term-host" ref={host} role="group" aria-label={`Terminal: ${label}`} />
      {live?.error && (
        <p className="error pad">
          {live.error}
          <button disabled={live.starting} onClick={() => { registry.start(id, start === "fresh" ? "fresh" : "resume"); }}>Try again</button>
        </p>
      )}
    </>
  );
}
