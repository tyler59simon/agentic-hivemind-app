// Which systems belong to a project. Living Memory keeps no such link, so it is read from the repositories both name.
import type { Project, System } from "../../lib/lm";

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");

/** Systems with a repository that is, contains, or sits inside one of the project's repositories. */
export function systemsForProject(project: Pick<Project, "repos">, systems: System[]): System[] {
  const repos = project.repos.map(norm).filter(Boolean);
  return systems.filter((s) => s.repos.map(norm).filter(Boolean).some((r) => repos.some((p) => within(r, p) || within(p, r))));
}
