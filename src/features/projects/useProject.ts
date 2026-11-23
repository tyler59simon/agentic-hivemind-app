// Data for one project's dashboard. The core queries (registry, member notes, open work, review, charter) load together;
// links, git and triage rows are separate hooks so each card loads and fails on its own.
import { useQuery } from "@tanstack/react-query";
import { useProjectsEnabled } from "../../lib/connection";
import { realProject } from "../../lib/folders";
import { gitActivity } from "../../lib/git";
import { links, list, openWork, projects, review } from "../../lib/lm";
import { useApp } from "../../store";
import { noteQuery } from "../viewer/NoteView";

export const projectsQuery = () => ({ queryKey: ["projects"], queryFn: () => projects() });

/** The project picked in the sidebar: undefined for "All memory" and "Other folders", and while the registry loads. */
export function useCurrentProject() {
  const slug = useApp((s) => realProject(s.project));
  const enabled = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled });
  const project = slug ? registry.data?.projects.find((p) => p.slug === slug) : undefined;
  return { enabled, registry, project };
}

export function useProject(slug: string | undefined) {
  const enabled = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled });
  const project = registry.data?.projects.find((p) => p.slug === slug);
  const tag = project?.tag ?? (slug ? `project/${slug}` : "");
  const on = enabled && !!project;
  const rows = useQuery({
    queryKey: ["list", "project", slug],
    queryFn: () => list({ allDomains: true, status: "any", tags: [tag], summary: true }),
    enabled: on,
  });
  const open = useQuery({
    queryKey: ["open", "project", slug],
    queryFn: () => openWork({ allDomains: true, tags: [tag], limit: 500 }),
    enabled: on,
  });
  const due = useQuery({
    queryKey: ["review", "project", slug],
    queryFn: () => review({ allDomains: true, tags: [tag], limit: 100 }),
    enabled: on,
  });
  const charterRef = project?.charter ?? null;
  const charter = useQuery({ ...noteQuery(charterRef ?? ""), enabled: on && !!charterRef });
  return { enabled, registry, project, rows, open, due, charter, loading: registry.isLoading };
}

/** The all-domains link graph (same key and call as the graph tab). */
export function useAllLinks(enabled = true) {
  return useQuery({ queryKey: ["links", "*"], queryFn: () => links({ allDomains: true, status: "any" }), enabled });
}

/** Recent commits and PRs; the file watcher never refetches this. */
export function useGitActivity(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["git", slug], queryFn: () => gitActivity(slug!), enabled: enabled && !!slug, staleTime: 60_000, retry: false,
  });
}

/** Every note in the store with summaries, files and tags: the candidates for triage. */
export function useTriageRows(enabled: boolean) {
  return useQuery({
    queryKey: ["list", "*", "any", "summary"],
    queryFn: () => list({ allDomains: true, status: "any", summary: true }),
    enabled,
  });
}
