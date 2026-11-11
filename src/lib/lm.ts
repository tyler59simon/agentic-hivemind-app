// Typed wrappers over the Living Memory CLI, reached through the Rust bridge (`serve --stdio`).
// Reads run as the viewer actor: read-only, and they leave no usage-diary events.
import { invoke } from "@tauri-apps/api/core";

export const NOTE_TYPES = [
  "knowledge", "decision", "preference", "context", "status",
  "bug", "plan", "risk", "research", "policy", "map", "runbook",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const STATUSES = ["active", "resolved", "archived", "superseded"] as const;
export type Status = (typeof STATUSES)[number];

export interface Reply<T = unknown> {
  exit_code: number;
  result: T;
  error: { code: string; message: string } | null;
}

export class LmError extends Error {
  constructor(public code: string, message: string, public exitCode: number) {
    super(message);
    this.name = "LmError";
  }
  get stale() { return this.exitCode === 6; }
}

export type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
let call: Invoke = invoke as Invoke;
/** Tests swap the transport. */
export function setTransport(fn: Invoke) { call = fn; }

export async function run<T>(argv: string[], stdin?: string): Promise<T> {
  const reply = (await call("lm", { argv, stdin: stdin ?? null })) as Reply<T>;
  if (reply.exit_code !== 0) {
    const error = reply.error ?? { code: "invalid", message: `Exit code ${reply.exit_code}` };
    throw new LmError(error.code, error.message, reply.exit_code);
  }
  return reply.result;
}

const view = (argv: string[]) => [...argv, "--actor", "viewer"];

export interface ConnectInfo {
  version: { api: number; python: string; commands: string[]; capabilities?: { learning?: number } };
  root: string;
  program: string;
  script: string;
  /** The signed-in OS user, when the system reports one. */
  user?: string | null;
}
export interface Settings {
  python: string | null; script: string | null; root: string | null;
  capture_shortcut?: string | null; close_to_tray?: boolean | null;
  claude_path?: string | null; agent_budget_usd?: number | null; architecture_suite_plugin?: string | null;
}
export interface CaptureStatus { shortcut: string | null; error: string | null; close_to_tray: boolean }

export const connect = () => call("connect", {}) as Promise<ConnectInfo>;
export const getSettings = () => call("get_settings", {}) as Promise<Settings>;
export const saveSettings = (value: Settings) => call("save_settings", { value }) as Promise<void>;
export const captureStatus = () => call("capture_status", {}) as Promise<CaptureStatus>;
export const showMain = () => call("show_main", {}) as Promise<void>;

export interface DomainInfo { name: string; bound: boolean; prefixes: string[]; active: number; archived: number }
export interface Domains {
  domains: DomainInfo[];
  aliases: Record<string, string>;
  global_domains: string[];
  foreign_domains: string[];
}
export const domains = () => run<Domains>(view(["domains"]));

export interface NoteRow {
  ref: string; id: string; domain: string; title: string; type: NoteType; status: Status;
  tags: string[]; created: string; updated: string; revision: string; path: string;
  summary?: string; files?: string[]; actions?: { open: number; done: number };
}
export interface ListPage { domains: string[]; total: number; offset: number; notes: NoteRow[] }
export interface ListOptions {
  domain?: string; allDomains?: boolean; status?: Status | "any";
  types?: NoteType[]; tags?: string[]; offset?: number; limit?: number; summary?: boolean;
}
export function listArgs(o: ListOptions): string[] {
  const argv = ["list"];
  if (o.allDomains) argv.push("--all-domains");
  else if (o.domain) argv.push("--domain", o.domain);
  if (o.status) argv.push("--status", o.status);
  for (const t of o.types ?? []) argv.push("--type", t);
  for (const t of o.tags ?? []) argv.push("--tag", t);
  if (o.offset) argv.push("--offset", String(o.offset));
  argv.push("--limit", String(o.limit ?? 1000));
  if (o.summary) argv.push("--with-summary");
  return view(argv);
}
export const list = (o: ListOptions) => run<ListPage>(listArgs(o));

export interface Note {
  id: string; domain: string; title: string; type: NoteType; status: Status; tags: string[];
  context?: string; files?: string[]; created?: string; updated?: string; review_by?: string;
  confirmed?: string[]; supersedes?: string[]; superseded_by?: string; origin?: string;
  revision: string; body: string; truncated: boolean;
  learning_procedure?: string; learning_version?: number; learning_state?: string; learning_pending_edit?: boolean;
}
/** LM's own default is 16,000 characters; Hivemind asks for the most it allows (64,000). */
export const read = (ref: string, opts: { domain?: string; maxChars?: number } = {}) =>
  run<Note>(view(["read", ref, "--max-chars", String(opts.maxChars ?? 64000), ...(opts.domain ? ["--domain", opts.domain] : [])]));

/** Properties only (no body): cheap, for origins and titles. */
export const meta = (ref: string) => run<Omit<Note, "body" | "truncated">>(view(["read", ref, "--metadata-only"]));

export interface SearchHit {
  id: string; domain: string; title: string; type: NoteType; updated: string; tags: string[];
  status: Status; snippet: string; score: number; rank: number; engine: string; revision: string;
  sourceField: string; sourceScope: "active" | "global" | "foreign"; similarity?: number;
}
export interface SearchResult { mode: string; domains: string[]; fallback: boolean; results: SearchHit[] }
export interface SearchOptions {
  query: string; domain: string; scope?: "active" | "fallback" | "all"; limit?: number;
  type?: NoteType; status?: Status; tag?: string;
}
export function searchArgs(o: SearchOptions): string[] {
  const argv = ["search", o.query, "--domain", o.domain, "--scope", o.scope ?? "fallback", "--limit", String(o.limit ?? 30)];
  const filters: [string, string | undefined][] = [["type", o.type], ["status", o.status], ["tag", o.tag]];
  let filtered = false;
  for (const [key, value] of filters) {
    if (value) { argv.push("--filter", `${key}=${value}`); filtered = true; }
  }
  // A filtered search refuses a stale index unless it may rebuild it (derived data only).
  if (filtered) argv.push("--rebuild");
  return view(argv);
}
export const search = (o: SearchOptions) => run<SearchResult>(searchArgs(o));

export const taxonomy = () => run<{ tags: string[]; facets?: string[] }>(view(["taxonomy"]));

/** The domain part of a `domain:id` ref. */
export const domainOf = (ref: string) => ref.slice(0, ref.indexOf(":"));

// ---- Writes (main actor). Every write is journaled by LM; Hivemind logs the operation IDs it caused. ----

export interface WriteResult {
  ok: true; operation_id?: string; state?: string; id: string; status: string; domain?: string; ref?: string;
  quality_warnings?: string[]; similar?: { ref: string; title: string }[]; inferred_tags?: string[];
  redacted?: { kind: string; field: string }[]; warning?: string; hint?: string;
  candidate_id?: string;
}

/** Fields `update` accepts; send only the ones that changed. */
export interface UpdatePayload {
  title?: string; body?: string; tags?: string[]; type?: NoteType; context?: string;
  review_by?: string | null; files?: string[]; expected_revision?: string;
}
export const update = (ref: string, payload: UpdatePayload, opts: { redact?: boolean } = {}) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), ...(opts.redact ? ["--redact"] : [])], JSON.stringify(payload));

export interface CapturePayload {
  title: string; body: string; tags: string[]; type: NoteType; context?: string; review_by?: string;
  files?: string[]; supersedes?: string[]; allow_similar?: boolean; origin?: string;
}
/** Hivemind's own captures carry this origin (LM sets `<harness>:<hash>` only for agent sessions). */
export const ORIGIN = "hivemind:local";
export const capture = (domain: string, payload: CapturePayload, opts: { redact?: boolean } = {}) =>
  run<WriteResult>(["capture", "--domain", domain, ...(opts.redact ? ["--redact"] : [])], JSON.stringify({ origin: ORIGIN, ...payload }));

export const check = (ref: string, index: number, done: boolean) =>
  run<WriteResult & { item: string; index: number; done: boolean; open: number }>(
    ["check", ref, "--index", String(index), "--domain", domainOf(ref), ...(done ? [] : ["--undo"])]);

export const confirm = (ref: string) =>
  run<WriteResult & { confirmed?: string[]; review_by?: string }>(["confirm", ref, "--domain", domainOf(ref)]);

// ---- Plans: make, inspect (as a diff), apply with the digest. ----

export interface Plan { ok: true; plan_id: string; digest: string; kind: string; summary: Record<string, unknown> }
export interface PlanEffect { path: string; expected_revision: string | null; action: "write" | "delete"; diff: string; truncated: boolean }
export interface PlanInspection extends Plan { effects: PlanEffect[] }
export type PlanAction = "archive" | "delete" | "resolve" | "reopen" | "rename" | "retag" | "update" | "supersede";

export function plan(action: PlanAction, ref: string, payload?: object): Promise<Plan> {
  const argv = ["plan", action, ref, "--domain", domainOf(ref)];
  return run<Plan>(argv, payload ? JSON.stringify(payload) : undefined);
}
export const mergePlan = (payload: { target: string; sources: string[]; body: string }) =>
  run<Plan>(["merge-plan"], JSON.stringify(payload));
export const retagPlan = (renames: Record<string, string>) => run<Plan>(["retag-plan"], JSON.stringify(renames));
export const taxonomyPlan = (tags: string[]) =>
  run<Plan & { summary: { added: string[]; alternatives: Record<string, string[]> } }>(["taxonomy-plan", ...tags]);
export const undo = (operationId: string) => run<Plan>(["undo", operationId]);
export const inspectPlan = (planId: string) => run<PlanInspection>(view(["inspect-plan", planId]));
export const applyPlan = (p: Pick<Plan, "plan_id" | "digest">) =>
  run<{ ok: true; operation_id: string; state: string; idempotent: boolean; warnings?: string[] }>(
    ["apply", p.plan_id, "--expected-plan-sha256", p.digest]);

// ---- History and links (read-only). ----

export interface Operation { operation_id: string; kind: string; state: string; created: string; files: string[] }
export const history = (o: { note?: string; limit?: number } = {}) =>
  run<Operation[]>(view(["history", ...(o.note ? ["--note", o.note] : []), "--limit", String(o.limit ?? 50)]));
export const diff = (operationId: string) => run<{ path: string; diff: string }[]>(view(["diff", operationId]));

export interface LinkNode { ref: string; id: string; domain: string; title: string; type: NoteType; status: Status; tags: string[] }
export interface LinkEdge { from: string; to: string; kind: "link" | "supersedes" }
export interface LinkGraph { domains: string[]; nodes: LinkNode[]; edges: LinkEdge[]; unresolved: { from: string; target: string }[] }
export const links = (o: { domain?: string; allDomains?: boolean; status?: "active" | "any" }) =>
  run<LinkGraph>(view(["links", ...(o.allDomains ? ["--all-domains"] : ["--domain", o.domain ?? ""]), "--status", o.status ?? "any"]));

// ---- Projects, open work, review and timeline (LM api 2). ----

export type ProjectStatus = "active" | "paused" | "archived";
export interface Project {
  slug: string; name: string; status: ProjectStatus; repos: string[]; aliases: string[]; description: string;
  charter: string | null; created: string; updated: string; tag: string; tag_registered: boolean;
}
export interface ProjectsResult { ok: boolean; projects: Project[]; warnings: string[] }
export const projectsArgs = (o: { status?: ProjectStatus | "any" } = {}) => view(["projects", ...(o.status ? ["--status", o.status] : [])]);
export const projects = (o: { status?: ProjectStatus | "any" } = {}) => run<ProjectsResult>(projectsArgs(o));

export interface ProjectCreate {
  slug: string; name: string; repos: string[]; description?: string; aliases?: string[];
  charter: { domain?: string; title?: string; body: string };
}
export interface ProjectUpdate {
  slug: string; name?: string; repos?: string[]; aliases?: string[]; description?: string;
  status?: ProjectStatus; charter?: string;
}
export const projectPlan = (action: "create" | "update" | "archive", payload: ProjectCreate | ProjectUpdate | { slug: string }) =>
  run<Plan>(["project-plan", action], JSON.stringify(payload));

interface ScopeOptions { domain?: string; allDomains?: boolean; tags?: string[]; limit?: number }
function scopeArgs(name: string, o: ScopeOptions): string[] {
  const argv = [name];
  if (o.allDomains) argv.push("--all-domains");
  else if (o.domain) argv.push("--domain", o.domain);
  for (const t of o.tags ?? []) argv.push("--tag", t);
  if (o.limit) argv.push("--limit", String(o.limit));
  return view(argv);
}

export interface OpenItem { ref: string; short_ref: string; title: string; type: NoteType; updated: string; index: number; item: string }
export interface OpenWork { ok: boolean; domain: string | null; notes: number; count: number; items: OpenItem[]; hint?: string }
export const openArgs = (o: ScopeOptions) => scopeArgs("open", o);
export const openWork = (o: ScopeOptions) => run<OpenWork>(openArgs(o));

export interface ReviewRow {
  ref: string; title: string; type: NoteType; updated: string;
  review_by?: string; confirmed?: string; revision?: string; domain?: string;
}
export interface ReviewResult { ok: boolean; domain: string | null; due: number; notes: ReviewRow[]; hint?: string }
export const reviewArgs = (o: ScopeOptions) => scopeArgs("review", o);
export const review = (o: ScopeOptions) => run<ReviewResult>(reviewArgs(o));

export interface TimelineRow { ref: string; short_ref: string; date: string; type: NoteType; title: string; status: string; anchor?: boolean }
export interface TimelineResult { ok: boolean; domain: string; by: "updated" | "created"; anchor: string | null; notes: TimelineRow[] }
export interface TimelineOptions {
  domain?: string; ref?: string; date?: string; before?: number; after?: number;
  type?: NoteType; by?: "updated" | "created"; all?: boolean;
}
export function timelineArgs(o: TimelineOptions): string[] {
  const argv = ["timeline"];
  if (o.ref) argv.push(o.ref);
  if (o.domain) argv.push("--domain", o.domain);
  if (o.date) argv.push("--date", o.date);
  if (o.before !== undefined) argv.push("--before", String(o.before));
  if (o.after !== undefined) argv.push("--after", String(o.after));
  if (o.type) argv.push("--type", o.type);
  if (o.by) argv.push("--by", o.by);
  if (o.all) argv.push("--all");
  return view(argv);
}
export const timeline = (o: TimelineOptions) => run<TimelineResult>(timelineArgs(o));

// ---- Systems (an LM that has the `systems` command). ----

export type SystemStatus = "active" | "deprecated" | "retired";
export interface System {
  slug: string; name: string; status: SystemStatus; description: string; owners: string[]; capabilities: string[];
  repos: string[]; depends_on: string[]; architecture: string | null; passport: string | null;
  created: string; updated: string; tag: string; tag_registered: boolean; dependents: string[];
}
export interface SystemsResult { ok: boolean; systems: System[]; warnings: string[] }
export const systemsArgs = (o: { status?: SystemStatus | "any" } = {}) => view(["systems", ...(o.status ? ["--status", o.status] : [])]);
export const systems = (o: { status?: SystemStatus | "any" } = {}) => run<SystemsResult>(systemsArgs(o));

export interface SystemCreate {
  slug: string; name: string; description?: string; owners?: string[]; capabilities?: string[]; repos?: string[];
  depends_on?: string[]; architecture?: string | null; passport: { domain?: string; title?: string; body: string };
}
export interface SystemUpdate {
  slug: string; name?: string; description?: string; status?: SystemStatus; owners?: string[]; capabilities?: string[];
  repos?: string[]; depends_on?: string[]; architecture?: string | null; passport?: string;
}
export const systemPlan = (action: "create" | "update" | "retire", payload: SystemCreate | SystemUpdate | { slug: string }) =>
  run<Plan>(["system-plan", action], JSON.stringify(payload));
