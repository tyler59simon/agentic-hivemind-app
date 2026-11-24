// Screen reader announcements (DESK-7): two live regions that are always in the page, one polite and one assertive.
// A region that appears with its text already in it is often not read, so the regions stay and only their text changes.
import { create } from "zustand";

type Urgency = "polite" | "assertive";
interface Said { text: string; n: number }
const useSaid = create<Record<Urgency, Said>>(() => ({ polite: { text: "", n: 0 }, assertive: { text: "", n: 0 } }));

/** Have a screen reader read `text`. Assertive interrupts what it is reading: use it for errors and requests that wait. */
export function announce(text: string, urgency: Urgency = "polite"): void {
  if (!text.trim()) return;
  useSaid.setState((s) => ({ [urgency]: { text, n: s[urgency].n + 1 } }));
}

/** The two regions. Mounted once per window. Each message is a new child (keyed by its count), so the same text said
 *  twice is read twice. */
export function Announcer() {
  const said = useSaid();
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite" data-announce="polite"><span key={said.polite.n}>{said.polite.text}</span></div>
      <div className="visually-hidden" aria-live="assertive" data-announce="assertive"><span key={said.assertive.n}>{said.assertive.text}</span></div>
    </>
  );
}
