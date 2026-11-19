// Pure helpers for agent sessions: status groups, the words the Start screen and chat use, and the briefing text.
import type { Place, Policy, ResourceUsage, SessionInfo, SessionStatus, Verdict } from "../../lib/agent";
import type { Project } from "../../lib/lm";
import { sections } from "../../lib/note";
import { isoDay } from "../projects/briefing";

export const ENDED: SessionStatus[] = ["succeeded", "failed", "cancelled", "ended"];
export const isEnded = (s: Pick<SessionInfo, "status">) => ENDED.includes(s.status);
export const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const POLICIES: { id: Exclude<Policy, "pre_approved">; label: string; help: string }[] = [
  { id: "ask", label: "Review edits", help: "Inspect proposed edits and approve commands when requested." },
  {
    id: "accept_edits", label: "Accept edits",
    help: "File edits apply in the worktree without asking, and so can simple file commands there, such as creating a folder. Other commands ask, unless something already allows them.",
  },
];

export function permissionLines(policy: Policy): string[] {
  switch (policy) {
    case "ask": return ["File edits require review", "Commands ask unless already allowed"];
    case "accept_edits": return ["File edits apply without asking", "Simple file commands in the worktree may run without asking", "Other commands ask unless already allowed"];
    case "pre_approved": return ["Unattended: pre-approved actions only"];
  }
}

/** Shown under the permission lines, so the UI never promises a question the CLI will not ask. */
export const ALLOWED_NOTE = "“Already allowed” means a rule in your own Claude Code settings, or one you added with “Always allow”. Reading files in the worktree never asks.";

/** "3 memory notes · 1 diagram · 1 repository" */
export const draftCounts = (notes: number, diagrams: number) =>
  `${notes} memory note${notes === 1 ? "" : "s"} · ${diagrams} diagram${diagrams === 1 ? "" : "s"} · 1 repository`;

/** The newest interactive session of the project that is still open and has the note in its context. */
export function sessionForNote(sessions: SessionInfo[], project: string, ref: string): SessionInfo | undefined {
  return sessions
    .filter((s) => s.mode === "interactive" && s.project === project && !isEnded(s) && s.context.includes(ref))
    .reduce<SessionInfo | undefined>((newest, s) => (!newest || s.startedAt > newest.startedAt ? s : newest), undefined);
}

export const VERDICT_LABELS: Record<Verdict, string> = { pass: "Verdict: pass", changes_needed: "Verdict: changes needed" };

/** A role session that never asks: its profile is pre-approved. Read-only profiles never ask, attended or not. */
export const isUnattended = (s: Pick<SessionInfo, "profile" | "policy">) => s.profile === "edit_worktree" && s.policy === "pre_approved";

/** "12% CPU · 340 MB · 3 processes" */
export function usageText(u: ResourceUsage): string {
  const memory = u.memoryMb >= 1024 ? `${(u.memoryMb / 1024).toFixed(1)} GB` : `${Math.round(u.memoryMb)} MB`;
  return `${Math.round(u.cpu)}% CPU · ${memory} · ${u.processes} process${u.processes === 1 ? "" : "es"}`;
}

/** README 7.3: files changed, no turn in progress, and the user has not decided. */
export const waitingForReview = (s: SessionInfo) =>
  (s.filesChanged?.files ?? 0) > 0 && s.status !== "running" && s.status !== "waiting" && (!s.review || s.review.state === "pending");

const NOTE_CHARS = 1200;

/** The notes' summaries and key details under a `## heading`; nothing for no notes. */
export function noteBlock(notes: { ref: string; title: string; type: string; body: string }[], heading: string): string {
  if (!notes.length) return "";
  const parts = notes.map((n) => {
    const s = sections(n.body);
    const text = [s.summary, s.details].filter(Boolean).join("\n\n").slice(0, NOTE_CHARS);
    return `### ${n.title} (${n.type}, ${n.ref})${text ? `\n${text}` : ""}`;
  });
  return `## ${heading}\n${parts.join("\n\n")}`;
}

export interface BriefingInput {
  project: Project; domain: string | null; repo: string; branch: string; policy: Policy;
  notes: { ref: string; title: string; type: string; body: string }[];
  architecture: { system: string; generated: string | null; behind: number | null; element: string | null; containers: string[] } | null;
  /** The project context pack: `buildBriefing(...)` with a 5,000 character limit. */
  pack: string;
  /** The change the session works on: a "## Change" block is written for it. */
  change?: { display: string; title: string; stage: string; briefTitle: string; steps: string[]; evidence: string[] } | null;
  /** Set for a terminal session: where it runs. The CLI's own permission mode applies there, so no permission line is written. */
  place?: Place;
  now?: Date;
}

/** The Markdown that goes before the task in a session's first message. */
export function sessionBriefing(input: BriefingInput): string {
  const { project, domain, repo, branch, policy, architecture: arch, now = new Date() } = input;
  const checkout = input.place === "checkout";
  const workspace = [
    "## Workspace",
    `- Repository: ${repo}`,
    checkout ? "- You are in the repository's own checkout, not a copy. Stay inside this folder." : `- You are in a git worktree of it, on a new branch created from \`${branch}\`. Stay inside this folder.`,
    checkout ? "- Do not push, merge or switch branches." : "- Do not push, merge, switch branches or delete the worktree.",
    input.place ? "" : policy === "accept_edits"
      ? "- File edits apply at once, and so can simple file commands in this folder. Other commands wait for the user's approval unless something already allows them."
      : "- File edits wait for the user's approval, and so do commands that nothing has allowed yet. A wait can be long; do not work around it.",
  ].filter(Boolean).join("\n");
  const change = input.change && [
    "## Change",
    `- This session works on ${input.change.display} ${input.change.title} (stage: ${input.change.stage}).`,
    ...(input.change.steps.length ? [`- Open steps: ${input.change.steps.join("; ")}`] : []),
    ...(input.change.evidence.length ? [`- Acceptance evidence still to show: ${input.change.evidence.join("; ")}`] : []),
    `- Link every note you capture for this change to its brief: \`--link '[[${input.change.briefTitle}]]'\`.`,
  ].join("\n");
  const architecture = arch && [
    "## Architecture",
    `- System: ${arch.system}.${arch.generated ? ` Model generated ${arch.generated}${arch.behind ? `, ${arch.behind} commit${arch.behind === 1 ? "" : "s"} behind the repository` : ""}.` : ""}`,
    ...(arch.containers.length ? [`- Containers: ${arch.containers.join(", ")}`] : []),
    ...(arch.element ? [`- The user attached: ${arch.element}`] : []),
  ].join("\n");
  const memory = [
    "## Living Memory",
    `- Record decisions and gotchas with \`--project ${project.slug}\`${domain ? ` \`--domain ${domain}\`` : ""}.`,
    "- Do not run its plan, apply or undo commands, or its archive, rewrite, remap, promote, taxonomy add, source, project, system or change writes; describe the change and the user will apply it.",
  ].join("\n");
  return [
    `# Session briefing: ${project.name}`,
    `> Built by Hivemind from Living Memory on ${isoDay(now)}. Reference only: check the code before acting on it.`,
    workspace, change, noteBlock(input.notes, "Included memory"), architecture, memory, "---", input.pack,
  ].filter(Boolean).join("\n\n");
}

/** True for a session that runs on Codex, in chat or in the terminal. */
export const isCodex = (s: Pick<SessionInfo, "adapter">) => s.adapter === "codex";
export const CODEX_COST_NOTE = "Codex does not report cost. The spend cap does not apply.";
export const CODEX_MODE_NOTE = "Codex keeps the permission mode it was started with.";

/** A Codex chat's permissions in the words of its app-server policy (section 5.10: untrusted, or on-request, in workspace-write). */
export function codexPermissionLines(policy: Policy): string[] {
  return policy === "accept_edits"
    ? ["File edits and commands in the worktree run without asking", "Codex asks before it goes outside its sandbox"]
    : ["File edits require review", "Commands ask unless Codex trusts them as read-only"];
}
export const CODEX_ALLOWED_NOTE = "Codex decides which commands are safe to run without asking. Codex has no “Always allow”.";
/** The Start screen's help for a permission choice, in the engine's words. */
export const policyHelp = (policy: Policy, codex: boolean) =>
  codex ? codexPermissionLines(policy).join(". ") + "." : POLICIES.find((p) => p.id === policy)?.help;

/** The command that continues a chat session's conversation in a terminal; null for a Codex session with no thread yet. */
export const resumeCommand = (s: Pick<SessionInfo, "adapter" | "id" | "engineSession">): string | null =>
  isCodex(s) ? (s.engineSession ? `codex resume ${s.engineSession}` : null) : `claude --resume ${s.id}`;

/** The first line of a transcript: the program the session runs. */
export const engineLabel = (s: Pick<SessionInfo, "adapter">) => (isCodex(s) ? "Codex" : "Claude Code");

/** A path relative to `root` when it lies inside it (either slash style, any drive-letter case), else as given. */
export function relativeTo(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const flat = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = flat(path);
  const r = flat(root);
  return p.toLowerCase().startsWith(r.toLowerCase() + "/") ? p.slice(r.length + 1) : path;
}

/** The files of a Codex edit request (`input.changes`) as rows to show; null when the input has no `changes` array. */
export function changeRows(input: unknown, root?: string | null): { path: string; diff: string }[] | null {
  const changes = (input as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return null;
  return changes.map((c: { path?: unknown; diff?: unknown }) => ({
    path: relativeTo(typeof c?.path === "string" ? c.path : "", root),
    diff: typeof c?.diff === "string" ? c.diff : "",
  }));
}
