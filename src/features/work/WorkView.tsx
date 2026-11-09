import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useConnection } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { domains, list, openWork, review, timeline } from "../../lib/lm";
import { useApp } from "../../store";
import { OpenWorkList } from "./OpenWorkList";
import { ReviewQueue } from "./ReviewQueue";
import { TimelineList } from "./TimelineList";
import { fromTimeline, toTimeline, workScope } from "./work";

type Section = "open" | "review" | "timeline";

export function WorkView() {
  const api = useConnection((s) => s.api);
  const appDomain = useApp((s) => s.domain);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const [picked, setPicked] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("open");
  const domain = picked ?? appDomain ?? (api >= 2 ? "*" : known.data?.domains[0]?.name ?? "");
  const all = domain === "*" && api >= 2;
  const scope = workScope(api, domain);
  const scopeKey = all ? "*" : domain;
  const ready = all || !!domain;

  const open = useQuery({ queryKey: ["open", scopeKey], queryFn: () => openWork({ ...scope, limit: 500 }), enabled: ready });
  const due = useQuery({ queryKey: ["review", scopeKey], queryFn: () => review({ ...scope, limit: 100 }), enabled: ready });
  // The default anchor is the newest note, so --before N lists the N notes just older than it (N + 1 newest in all).
  const line = useQuery({
    queryKey: ["timeline", domain], queryFn: () => timeline({ domain, before: 50 }), enabled: !!domain && !all && section === "timeline",
  });
  const everything = useQuery({
    queryKey: ["list", "*", "any"], queryFn: () => list({ allDomains: true, status: "any" }), enabled: all && section === "timeline",
  });
  const rows = useMemo(
    () => (all ? toTimeline(everything.data?.notes ?? [], "updated").slice(0, 200) : line.data ? fromTimeline(line.data) : []),
    [all, everything.data, line.data],
  );

  const sections: { id: Section; label: string; count?: number }[] = [
    { id: "open", label: "Open work", count: open.data?.count },
    { id: "review", label: "Review due", count: due.data?.due },
    { id: "timeline", label: "Timeline", count: section === "timeline" ? rows.length : undefined },
  ];
  const current = section === "open" ? open : section === "review" ? due : all ? everything : line;

  return (
    <div className="work">
      <div className="graph-filters">
        <select value={domain} onChange={(e) => setPicked(e.target.value)} aria-label="Domain">
          {api >= 2 && <option value="*">All domains</option>}
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <div className="segmented compact">
          {sections.map((s) => (
            <button key={s.id} className={section === s.id ? "on" : ""} onClick={() => setSection(s.id)}>
              {s.label}{s.count !== undefined ? ` (${s.count})` : ""}
            </button>
          ))}
        </div>
      </div>
      {current.isLoading && <p className="muted pad">Loading…</p>}
      {current.error && <p className="error pad">{classify(current.error).message}</p>}
      {section === "open" && open.data && <OpenWorkList items={open.data.items} />}
      {section === "review" && due.data && <ReviewQueue rows={due.data.notes} />}
      {section === "timeline" && (all ? everything.data : line.data) && <TimelineList rows={rows} />}
    </div>
  );
}
