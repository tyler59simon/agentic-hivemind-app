import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Engine } from "../../lib/agent";
import { modKey } from "../../lib/platform";
import type { StartMode } from "../../lib/term";
import { reloadKey, swallow } from "./keys";
import * as registry from "./registry";

/** Find in the terminal's scrollback. Enter finds the next match, Shift+Enter the previous one, Escape closes. */
function FindBar({ id }: { id: string }) {
  const live = registry.useLive(id);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  useEffect(() => { input.current?.focus(); }, []);
  if (!live) return null;
  const opts = { decorations: registry.FIND_DECORATIONS };
  const next = () => { if (text) live.search.findNext(text, opts); };
  const prev = () => { if (text) live.search.findPrevious(text, opts); };
  const change = (value: string) => {
    setText(value);
    if (value) live.search.findNext(value, { ...opts, incremental: true });
    else live.search.clearDecorations();
  };
  const { index, count } = live.matches;
  return (
    <div className="find-bar" role="search">
      <input
        ref={input} value={text} placeholder="Find in terminal" aria-label="Find in terminal"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (reloadKey(e.nativeEvent)) e.preventDefault();
          if (e.key === "Escape") registry.closeFind(id);
          else if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
        }}
      />
      <span className="find-count" aria-live="polite">{text ? (count > 0 ? `${index + 1} of ${count}` : "No matches") : ""}</span>
      <button className="icon-button" title="Previous match" aria-label="Previous match" onClick={prev}><ChevronUp size="1.1em" aria-hidden /></button>
      <button className="icon-button" title="Next match" aria-label="Next match" onClick={next}><ChevronDown size="1.1em" aria-hidden /></button>
      <button className="icon-button" title="Close" aria-label="Close find" onClick={() => registry.closeFind(id)}><X size="1.1em" aria-hidden /></button>
    </div>
  );
}

/** One terminal's screen. The xterm instance lives in the registry; this component only gives it a place. */
export function TerminalView({ id, sessionId, engine, start, label, shell = false, focused = true }: {
  id: string; sessionId: string | null; engine: Engine | null; start: StartMode | null; label: string;
  /** A PowerShell tab: the id is the backend's `shell-<uuid>`, and the terminal attaches to the running shell. */
  shell?: boolean;
  /** False in a pane that is not the focused one: the terminal is shown without taking the keyboard. */
  focused?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = registry.useLive(id);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    registry.ensure(id, { sessionId, engine, start, shell });
    registry.mount(id, el, { focus: focused });
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

  useEffect(() => { if (focused) registry.focusTerm(id); else registry.setFocusable(id, false); }, [focused, id]);

  return (
    <>
      <div className="term-host" ref={host} role="group" aria-label={`Terminal: ${label}`} />
      {live?.finding
        ? <FindBar id={id} />
        : <button className="icon-button find-open" title={`Find (${modKey()}+Shift+F)`} aria-label="Find in terminal" onClick={() => registry.openFind(id)}><Search size="1.1em" aria-hidden /></button>}
      {live?.error && (
        <p className="error pad">
          {live.error}
          <button disabled={live.starting} onClick={() => { registry.start(id, start === "fresh" ? "fresh" : "resume"); }}>Try again</button>
        </p>
      )}
    </>
  );
}
