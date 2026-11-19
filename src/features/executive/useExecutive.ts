// Data for the Executive page: Hivemind's records (key ["executive", kind], refreshed by `executive-changed`) and one
// all-domain read of Living Memory's notes and open items (keys start with "list" and "open", so store changes refetch them).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { recordsQuery, type CaptureBatch, type Health, type Milestone, type RecordKind } from "../../lib/executive";
import { domains, list, openWork, taxonomy, type Project } from "../../lib/lm";
import { projectsQuery, useCurrentProject } from "../projects/useProject";
import { isoToday } from "./commitments";
import { attention, crossProject, portfolio } from "./portfolio";

export const useRecords = <T>(kind: RecordKind) => useQuery(recordsQuery<T>(kind));

export function useNotes() {
  const rows = useQuery({ queryKey: ["list", "executive"], queryFn: () => list({ allDomains: true, status: "active", summary: true }) });
  const open = useQuery({ queryKey: ["open", "executive"], queryFn: () => openWork({ allDomains: true, limit: 1000 }) });
  return { rows, open };
}

/** The portfolio, scoped to the project picked in the sidebar (or every project). */
export function usePortfolio() {
  const { project } = useCurrentProject();
  const registry = useQuery(projectsQuery());
  const { rows, open } = useNotes();
  const milestones = useRecords<Milestone>("milestone");
  const health = useRecords<Health>("health");
  const today = isoToday();
  const all = useMemo(
    () => portfolio(registry.data?.projects ?? [], rows.data?.notes ?? [], open.data?.items ?? [], milestones.data ?? [], health.data ?? [], today),
    [registry.data, rows.data, open.data, milestones.data, health.data, today],
  );
  const scoped = project ? all.filter((r) => r.project.slug === project.slug) : all;
  const loose = useMemo(() => crossProject(open.data?.items ?? [], rows.data?.notes ?? [], today), [open.data, rows.data, today]);
  return {
    project, today, rows: scoped, all, attention: attention(scoped, today), crossProject: project ? [] : loose,
    projects: (registry.data?.projects ?? []).filter((p: Project) => p.status !== "archived"),
    loading: registry.isLoading || rows.isLoading || open.isLoading, error: registry.error ?? rows.error ?? open.error,
  };
}

/** Capture batches with items still waiting, newest first. */
export function useInbox() {
  const batches = useRecords<CaptureBatch>("capture");
  const waiting = (batches.data ?? []).filter((b) => b.items.some((i) => i.state === "pending") || (b.items.length === 0 && b.questions.length));
  return { batches, waiting, count: waiting.reduce((n, b) => n + b.items.filter((i) => i.state === "pending").length, 0) };
}

/** What writing a captured item needs to know about the store. */
export function useStoreFacts() {
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const doms = useQuery({ queryKey: ["domains"], queryFn: domains });
  const names = doms.data?.domains.map((d) => d.name) ?? [];
  return {
    known: tax.data?.tags ?? [],
    globalDomain: doms.data?.global_domains[0],
    defaultDomain: names.find((n) => !doms.data?.global_domains.includes(n)) ?? names[0] ?? "",
    ready: tax.isSuccess && doms.isSuccess,
  };
}
