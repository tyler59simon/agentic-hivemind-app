// Data for one system's passport. The registry and member notes load together; the architecture folder is a
// separate query so its cards load and fail on their own, and the file watcher never refetches it.
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { systemArchitecture, systemDiagram } from "../../lib/architecture";
import { useSystemsEnabled } from "../../lib/connection";
import { list, systems } from "../../lib/lm";
import { noteQuery } from "../viewer/NoteView";

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
