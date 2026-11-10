// Data for one system's passport. The registry and member notes load together; the architecture folder is a
// separate query so its cards load and fail on their own, and the file watcher never refetches it.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { systemArchitecture, systemDiagram } from "../../lib/architecture";
import { useSystemsEnabled } from "../../lib/connection";
import { sessionsQuery } from "../../lib/agent";
import { list, systems, type System } from "../../lib/lm";
import { noteQuery } from "../viewer/NoteView";
import { proposalOf, proposedUpdate } from "./passport";

export const systemsQuery = () => ({ queryKey: ["systems"], queryFn: () => systems() });

/** The create wizard is opened from the sidebar and from the command palette. */
export const useSystemIntent = create<{ wizard: boolean; openWizard: () => void; closeWizard: () => void }>((set) => ({
  wizard: false,
  openWizard: () => set({ wizard: true }),
  closeWizard: () => set({ wizard: false }),
}));

export function useSystem(slug: string | undefined) {
  const enabled = useSystemsEnabled();
  const registry = useQuery({ ...systemsQuery(), enabled });
  const system = registry.data?.systems.find((s) => s.slug === slug);
  const tag = system?.tag ?? (slug ? `system/${slug}` : "");
  const on = enabled && !!system;
  const rows = useQuery({
    queryKey: ["list", "system", slug],
    queryFn: () => list({ allDomains: true, status: "any", tags: [tag], summary: true }),
    enabled: on,
  });
  const passportRef = system?.passport ?? null;
  const passport = useQuery({ ...noteQuery(passportRef ?? ""), enabled: on && !!passportRef });
  const architecture = useQuery({
    queryKey: ["architecture", slug, system?.architecture ?? null],
    queryFn: () => systemArchitecture(slug!),
    enabled: on, staleTime: 60_000, retry: false,
  });
  return { enabled, registry, system, rows, passport, architecture, loading: registry.isLoading };
}

/** One diagram as a data URL; loaded when its card scrolls into use, and kept until the folder is regenerated. */
export function useDiagram(slug: string, path: string, version: number | null, enabled = true) {
  return useQuery({
    queryKey: ["architecture", slug, "diagram", path, version],
    queryFn: () => systemDiagram(slug, path),
    enabled, staleTime: Infinity, retry: false,
  });
}

const DISMISSED = "hivemind.system-proposals-dismissed";
const dismissedProposals = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]"); } catch { return []; } };

/** For each system: the agent sessions run for it, and the registry update the newest successful one proposed (until dismissed). */
export function useSystemProposals(systems: System[], all: System[]) {
  const sessions = useQuery(sessionsQuery());
  const [dismissed, setDismissed] = useState(dismissedProposals);
  const items = useMemo(() => systems.map((system) => {
    const mine = (sessions.data ?? []).filter((s) => s.task.kind === "system_passport" && s.task.slug === system.slug);
    const proposer = mine.find((s) => s.status === "succeeded");
    const update = proposer && !dismissed.includes(proposer.id) ? proposedUpdate(system, proposalOf(proposer.structured), all.map((s) => s.slug)) : null;
    /** The proposed fields, in words: "description, depends on". */
    const fields = update ? Object.keys(update).filter((k) => k !== "slug").join(", ").replace(/_/g, " ") : "";
    return { system, latest: mine[0], proposer, update, fields };
  }), [systems, all, sessions.data, dismissed]);
  const dismiss = (sessionId: string) => {
    const next = [...dismissedProposals(), sessionId].slice(-50);
    try { localStorage.setItem(DISMISSED, JSON.stringify(next)); } catch { /* not persisted */ }
    setDismissed(next);
  };
  return { items, dismiss };
}

export function useSystemProposal(system: System, all: System[]) {
  const one = useMemo(() => [system], [system]);
  const { items, dismiss } = useSystemProposals(one, all);
  const item = items[0];
  return { ...item, dismiss: () => { if (item.proposer) dismiss(item.proposer.id); } };
}
