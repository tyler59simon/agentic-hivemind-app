// The parts of daily notes and templates that draw (NS-7A): the dialog that starts a page from a template, the previous and
// next day buttons on a daily page, and the rail's calendar. What they do is in `dailyActions.ts`.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { treeQuery } from "../../documents/io";
import { useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { isMarkdown, pageTitle } from "../../lib/notebooks";
import { isLoose } from "../../lib/opens";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { projectsQuery } from "../projects/useProject";
import { addDays, dailyDateOf, dailyPath, formatDate } from "./daily";
import { listTemplates, newPageFromTemplate, openDay } from "./dailyActions";
import { dailyQuery } from "./dailyPages";

/** Which notebook and folder a "New page from template" is asked for. The Notes page shows the dialog; the notebook's menu,
 *  a section's menu and the command palette open it. */
export const useTemplateIntent = create<{ target: { notebook: string; folder: string } | null; open: (notebook: string, folder?: string) => void; close: () => void }>((set) => ({
  target: null,
  open: (notebook, folder = "") => set({ target: { notebook, folder } }),
  close: () => set({ target: null }),
}));

/** Ask for a template and a title, then make the page and open it. */
export function NewFromTemplate() {
  const target = useTemplateIntent((s) => s.target);
  const close = useTemplateIntent((s) => s.close);
  const client = useQueryClient();
  const notebook = target?.notebook ?? "";
  const templates = useQuery({ queryKey: ["templates", notebook], queryFn: () => listTemplates(client, notebook), enabled: !!target, staleTime: 0 });
  const projectsOn = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled: !!target && projectsOn });
  const [template, setTemplate] = useState("");
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTemplate(""); setTitle(""); setProject(""); }, [target?.notebook, target?.folder]);
  if (!target) return null;
  const list = templates.data ?? [];
  const chosen = list.includes(template) ? template : list[0] ?? "";
  const active = (registry.data?.projects ?? []).filter((p) => p.status === "active");
  const make = async () => {
    setBusy(true);
    try {
      await newPageFromTemplate(client, { notebook, folder: target.folder, template: chosen, title, project: active.find((p) => p.slug === project)?.name });
      close();
    } catch (e) {
      toast(classify(e).message, "error");
      setBusy(false);
    }
  };
  return (
    <Modal title="New page from template" onClose={close} locked={busy}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (chosen && !busy) void make(); }}>
        {templates.isLoading && <p className="muted">Looking for templates…</p>}
        {templates.error && <p className="error">{classify(templates.error).message}</p>}
        {templates.data && !list.length && <p className="muted">This notebook has no templates yet. A template is a page in its templates folder (set in Notebook settings); it can use {"{{title}}"}, {"{{date}}"}, {"{{time}}"}, {"{{notebook}}"}, {"{{project}}"} and {"{{cursor}}"}.</p>}
        {list.length > 0 && (
          <>
            <label className="field"><span>Template</span>
              <select value={chosen} onChange={(e) => setTemplate(e.target.value)}>{list.map((t) => <option key={t} value={t}>{pageTitle(t)}</option>)}</select>
            </label>
            <label className="field"><span>Title</span><input autoFocus value={title} placeholder="Untitled" onChange={(e) => setTitle(e.target.value)} /></label>
            {projectsOn && active.length > 0 && (
              <label className="field"><span>Project</span>
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="">None</option>
                  {active.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <div className="actions">
          <button type="button" onClick={close} disabled={busy}>Cancel</button>
          <button className="primary" disabled={!chosen || busy}>{busy ? "Creating…" : "Create page"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Previous and next day, on a page that is a daily page of its notebook. They open the neighbouring day's page, making it
 *  from the daily template when it is not there yet. */
export function DayNav({ file }: { file: { notebook: string; path: string } }) {
  const client = useQueryClient();
  const info = useQuery({ ...dailyQuery(file.notebook), enabled: !isLoose(file) && isMarkdown(file.path) });
  const date = info.data ? dailyDateOf(info.data.settings, file.path) : null;
  if (!date) return null;
  const go = (step: number) => openDay(client, file.notebook, addDays(date, step)).catch((e) => toast(classify(e).message, "error"));
  return (
    <span className="day-nav" role="group" aria-label="Daily notes">
      <button className="icon-button" title="Previous day" aria-label="Previous day" onClick={() => void go(-1)}><ChevronLeft size="1.2em" aria-hidden /></button>
      <button className="icon-button" title="Next day" aria-label="Next day" onClick={() => void go(1)}><ChevronRight size="1.2em" aria-hidden /></button>
    </span>
  );
}

const WEEK = ["S", "M", "T", "W", "T", "F", "S"];

/** The weeks of the month holding `first`, Sunday first, with the days outside the month as null. */
export function monthGrid(first: Date): (Date | null)[][] {
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1))];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** A month of the notebook's days, marking the ones that have a daily page. A click opens a day, making its page when it is
 *  missing. */
export function DailyCalendar({ notebook, page }: { notebook: string; page?: string }) {
  const client = useQueryClient();
  const info = useQuery(dailyQuery(notebook));
  const tree = useQuery(treeQuery(notebook));
  const shown = info.data && page ? dailyDateOf(info.data.settings, page) : null;
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  // Showing a daily page brings its month into view.
  useEffect(() => { if (shown) setMonth(new Date(shown.getFullYear(), shown.getMonth(), 1)); }, [shown?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const existing = useMemo(() => new Set((tree.data?.entries ?? []).filter((e) => e.kind === "page").map((e) => e.path.toLowerCase())), [tree.data]);
  if (!info.data) return <p className="muted pad">{info.error ? classify(info.error).message : "Loading…"}</p>;
  const settings = info.data.settings;
  const today = new Date();
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const step = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="icon-button" aria-label="Previous month" onClick={() => step(-1)}><ChevronLeft size="1.1em" aria-hidden /></button>
        <span className="calendar-month">{formatDate(month, "MMMM YYYY")}</span>
        <button className="icon-button" aria-label="Next month" onClick={() => step(1)}><ChevronRight size="1.1em" aria-hidden /></button>
      </div>
      <div className="calendar-grid" role="grid" aria-label={formatDate(month, "MMMM YYYY")}>
        {WEEK.map((d, i) => <span key={i} className="calendar-dow" role="columnheader">{d}</span>)}
        {monthGrid(month).flat().map((day, i) => {
          if (!day) return <span key={i} />;
          const has = existing.has(dailyPath(settings, day).toLowerCase());
          const cls = ["calendar-day", has ? "has-page" : "", same(day, today) ? "today" : "", shown && same(day, shown) ? "shown" : ""].filter(Boolean).join(" ");
          return (
            <button key={i} className={cls} aria-label={`${formatDate(day, "D MMMM YYYY")}${has ? ", has a page" : ""}`} aria-current={same(day, today) ? "date" : undefined}
              onClick={() => openDay(client, notebook, day).catch((e) => toast(classify(e).message, "error"))}>{day.getDate()}</button>
          );
        })}
      </div>
    </div>
  );
}
