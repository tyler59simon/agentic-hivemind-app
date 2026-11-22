// Which systems belong to a project: the system's own `project` field when it has one, else the repositories both name.
import type { Project, System } from "../../lib/lm";

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");

/** Whether `path` is one of `repos` or inside one (slashes and case do not matter). */
export function insideRepos(path: string, repos: string[]): boolean {
  const p = norm(path);
  return repos.map(norm).filter(Boolean).some((r) => within(p, r));
}

/** Systems that name this project, plus the ones that name none and have a repository that is, contains, or sits inside one of
 *  the project's repositories. A system with a project of its own never matches by repository when the caller gives a slug;
 *  without a slug (a repository-only lookup) every system matches by repository. */
export function systemsForProject(project: Pick<Project, "repos"> & { slug?: string }, systems: System[]): System[] {
  const repos = project.repos.map(norm).filter(Boolean);
  return systems.filter((s) => (project.slug && s.project ? s.project === project.slug : s.repos.map(norm).filter(Boolean).some((r) => repos.some((p) => within(r, p) || within(p, r)))));
}
