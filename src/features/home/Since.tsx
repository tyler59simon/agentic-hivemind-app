// "Since you were last here": what Living Memory's recap says changed since the last visit to this Home (at least a day, at most
// 90), and for a project the commits and pull requests of its repositories. Hidden when Living Memory has no recap command.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useRecapEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import type { RepoActivity } from "../../lib/git";
import { recap } from "../../lib/lm";
import { Section, dayMonth } from "../../ui/Page";
import { NoteLink } from "../preview/NoteLink";
import { changeGroups, harnessLine, isQuiet, isUnbound, repeatLabel } from "../recap/recap";
import { lastVisit, rememberVisit, sinceDays } from "./home";
import { Commits } from "./panels";

/** How many days back this visit reads. Recorded on unmount, window hide (close-to-tray), and pagehide; recomputed when shown again. */
export function useVisit(scope: string): number {
  const [days, setDays] = useState(() => sinceDays(lastVisit(scope), Date.now()));
  useEffect(() => {
    const stamp = () => rememberVisit(scope);
    const onVis = () => {
      if (document.hidden) stamp();
      else setDays(sinceDays(lastVisit(scope), Date.now()));
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", stamp);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", stamp);
      stamp();
    };
  }, [scope]);
  return days;
}

/** Notes a change group lists before the rest are left to Memory. */
const SHOWN = 8;

export function Since({ days, project, git }: { days: number; project?: string; git?: { loading: boolean; error: unknown; repos: RepoActivity[] } }) {
  const enabled = useRecapEnabled();
  const q = useQuery({ queryKey: ["recap", days, project ?? "*"], queryFn: () => recap({ days, project }), enabled });
  const [all, setAll] = useState(false);
  if (!enabled) return null;
  const r = q.data;
  const groups = r ? changeGroups(r) : [];
  const changed = groups.filter((g) => g.group === "created" || g.group === "updated").flatMap((g) => g.items.map((c) => ({ ...c, group: g.group })));
  const shown = all ? changed : changed.slice(0, SHOWN);
  const commits = git?.repos.reduce((n, x) => n + (x.commits?.length ?? 0), 0) ?? 0;
  const prs = git?.repos.reduce((n, x) => n + (x.prs?.length ?? 0), 0) ?? 0;
  return (
    <Section title={`Since you were last here${r ? ` (${dayMonth(r.since)})` : ""}`} loading={q.isLoading}
      error={isUnbound(q.error) ? undefined : q.error}
      empty={isUnbound(q.error) ? "This project has no bound domain, so there is nothing to recap yet." : undefined}>
      {r && (
        <>
          <p className="muted small">
            {[`${groups.reduce((n, g) => n + g.total, 0)} note changes`, `${r.sessions.count} agent sessions${r.sessions.count ? ` (${harnessLine(r.sessions.by_harness)})` : ""}`,
              git && `${commits} commits`, git && `${prs} pull requests`].filter(Boolean).join(" · ")}
          </p>
          {isQuiet(r) && !commits && <p className="muted">Nothing changed in Living Memory in the last {days} day{days === 1 ? "" : "s"}.</p>}
          {!!shown.length && (
            <ul className="item-list since-list">
              {shown.map((c) => (
                <li key={`${c.group}:${c.ref}`}><NoteLink row={{ ref: c.ref, title: c.title ?? c.ref }} /> <span className="muted small">{[c.group, repeatLabel(c.count)].filter(Boolean).join(", ")}</span></li>
              ))}
            </ul>
          )}
          {changed.length > SHOWN && !all && <button className="link small" onClick={() => setAll(true)}>Show all {changed.length}</button>}
        </>
      )}
      {git && (git.error ? <p className="muted small">Git activity is unavailable: {classify(git.error).message}</p> : git.loading ? null : <Commits repos={git.repos} />)}
    </Section>
  );
}
