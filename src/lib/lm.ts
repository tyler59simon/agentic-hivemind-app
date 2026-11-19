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

/** What `version` reports under `capabilities`. */
export interface Capabilities { direct_writes?: number; history?: number; restore?: number; pin?: number; rule?: number; maintenance?: { version: number; actions: string[] } }

export interface ConnectInfo {
  version: { api: number; python: string; commands: string[]; capabilities?: Capabilities };
  root: string;
  program: string;
  script: string;
  /** The signed-in OS user, when the system reports one. */
  user?: string | null;
}
export interface Settings {
  python: string | null; script: string | null; root: string | null;
  capture_shortcut?: string | null; close_to_tray?: boolean | null;
  claude_path?: string | null; codex_path?: string | null; agent_budget_usd?: number | null; architecture_suite_plugin?: string | null;
  /** Folders chosen with the native picker; read-only here, Rust ignores it on save. */
  other_folders?: string[] | null;
  /** Commands agent sessions may run without asking, per project slug. Rust checks each one. */
  allowed_commands?: Record<string, string[]> | null;
  /** Whether finished sessions are reviewed for knowledge and skills (default on), and the daily cap shared with automations. */
  learning_reviewer?: boolean | null; learning_daily_usd?: number | null;
  /** Whether reviewed patches to a well-used skill are published without asking (default off). */
  skills_auto_patch?: boolean | null;
  /** An architecture-rules/v1 file per system slug, for the drift check. */
  architecture_rules?: Record<string, string> | null;
  /** Engines hidden from the interface; Rust refuses a save that hides both. */
  hidden_engines?: ("claude" | "codex")[] | null;
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
  /** Absent means not pinned. */
  pinned?: boolean;
  /** Absent means not a rule. Only policy and preference notes can be rules. */
  rule?: boolean;
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

// ---- Proposals: drafts agents (and Hivemind's reviewer) staged for the user to accept or reject. ----
export interface MemoryProposal { id: string; status: string; created: string; domain: string; type: NoteType; title: string; note_ref?: string; reason?: string }
export interface MemoryProposalDetail {
  id: string; status: string; created: string; domain: string; warnings?: string[];
  note: { title: string; body: string; type?: NoteType; tags?: string[]; context?: string };
}
export const proposalsList = () => run<{ ok: boolean; proposals: MemoryProposal[] }>(view(["proposals", "list"]));
export const proposalShow = (id: string) => run<MemoryProposalDetail>(view(["proposals", "show", id]));
/** Save the draft as staged, into the domain it was proposed for. */
export const proposalAccept = (id: string) => run<WriteResult>(["capture", "--from-proposal", id]);
/** Save a draft that has no concern tag the store knows (Living Memory refuses those), with the one the user picked. */
export const proposalAcceptWith = (id: string, note: { title: string; body: string; type?: NoteType }, concern: string) =>
  run<WriteResult>(["capture", "--from-proposal", id, "--type", note.type ?? "knowledge", "--concern", concern, note.title, note.body]);
export const proposalReject = (id: string, reason?: string) => run<{ ok: boolean }>(["proposals", "reject", id, ...(reason ? ["--reason", reason] : [])]);

export const check = (ref: string, index: number, done: boolean) =>
  run<WriteResult & { item: string; index: number; done: boolean; open: number }>(
    ["check", ref, "--index", String(index), "--domain", domainOf(ref), ...(done ? [] : ["--undo"])]);

export const confirm = (ref: string) =>
  run<WriteResult & { confirmed?: string[]; review_by?: string }>(["confirm", ref, "--domain", domainOf(ref)]);

/** Replace (or add) the detail bullet with this label. LM ignores stdin when a section flag is given,
 *  so the expected revision goes in argv and no payload is sent. */
export const setDetail = (ref: string, text: string, expectedRevision?: string) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), "--set-detail", text, ...(expectedRevision ? ["--expected-revision", expectedRevision] : [])]);

// ---- Direct writes: one journaled step, no plan. The receipt names the operation, so it can be undone. ----

/** `kind` and `summary` are absent from the receipt of a note write such as archive. */
export interface Receipt { ok: true; operation_id: string; state: string; kind?: string; summary?: Record<string, unknown>; undo: string; warnings?: string[] }

const direct = (argv: string[], payload?: object) => run<Receipt>(argv, payload ? JSON.stringify(payload) : undefined);

export const archiveNote = (ref: string) => direct(["archive", ref, "--domain", domainOf(ref)]);
export const resolveNote = (ref: string) => direct(["resolve", ref, "--domain", domainOf(ref)]);
export const reopenNote = (ref: string) => direct(["reopen", ref, "--domain", domainOf(ref)]);
/** `by` is the ID or ref of a note in the same domain. */
export const supersedeNote = (ref: string, by: string) => direct(["supersede", ref, "--by", by, "--domain", domainOf(ref)]);
export const taxonomyAdd = (tags: string[]) => direct(["taxonomy", "add", ...tags]);

// ---- Plans (delete, merge, bulk retag and the kept kinds): make, inspect (as a diff), apply with the digest. ----

export interface Plan { ok: true; plan_id: string; digest: string; kind: string; summary: Record<string, unknown> }
export interface PlanEffect { path: string; expected_revision: string | null; action: "write" | "delete"; diff: string; truncated: boolean }
export interface PlanInspection extends Plan { effects: PlanEffect[] }
export type PlanAction = "delete";

export function plan(action: PlanAction, ref: string): Promise<Plan> {
  return run<Plan>(["plan", action, ref, "--domain", domainOf(ref)]);
}
export const mergePlan = (payload: { target: string; sources: string[]; body: string }) =>
  run<Plan>(["merge-plan"], JSON.stringify(payload));
export const retagPlan = (renames: Record<string, string>) => run<Plan>(["retag-plan"], JSON.stringify(renames));
/** Undoing a direct write returns a receipt at once; an operation of a kept plan kind (merge, delete, ...) returns a plan. */
export const undo = (operationId: string) => run<Receipt | Plan>(["undo", operationId]);
export const isPlan = (r: Receipt | Plan): r is Plan => "plan_id" in r;
export const inspectPlan = (planId: string) => run<PlanInspection>(view(["inspect-plan", planId]));
export const applyPlan = (p: Pick<Plan, "plan_id" | "digest">) =>
  run<{ ok: true; operation_id: string; state: string; idempotent: boolean; warnings?: string[] }>(
    ["apply", p.plan_id, "--expected-plan-sha256", p.digest]);

// ---- History and links (read-only). ----

/** `summary` and `actor` come from Living Memory with history level 3; older versions omit them. */
export interface Operation { operation_id: string; kind: string; state: string; created: string; files: string[]; summary?: string; actor?: string }
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
export const writeProject = (action: "create" | "update" | "archive", payload: ProjectCreate | ProjectUpdate | { slug: string }) =>
  direct(["project", action], payload);

interface ScopeOptions { domain?: string; allDomains?: boolean; tags?: string[]; limit?: number; kind?: string[] }
function scopeArgs(name: string, o: ScopeOptions): string[] {
  const argv = [name];
  if (o.allDomains) argv.push("--all-domains");
  else if (o.domain) argv.push("--domain", o.domain);
  for (const t of o.tags ?? []) argv.push("--tag", t);
  for (const k of o.kind ?? []) argv.push("--kind", k);
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
  /** From the richer worklist only; older stores send none of these. */
  kinds?: ReviewKind[]; reason?: string; action?: ReviewAction; pair?: { ref: string; title: string; score: number };
}
export const REVIEW_KINDS = ["stale", "due", "interim", "duplicate", "warned", "noisy"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export type ReviewAction = "confirm" | "update" | "supersede" | "resolve" | "merge-plan" | "archive";
export interface ReviewResult {
  ok: boolean; domain: string | null; due: number; notes: ReviewRow[]; hint?: string;
  counts?: Record<ReviewKind, number>;
}
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

/** One line of the `log` command: a journaled note event, a change event or an agent session. */
export interface LogRow {
  time: string; event: string; ref: string; title: string; type: string; domain: string; projects: string[]; op?: string;
  detail?: string;
  /** Note and change rows: what changed, and who did it (maintenance, auto_resolve, obsidian, undo, plan, agent:HARNESS or command). */
  summary?: string; actor?: string;
  /** Session rows only. */
  harness?: string; notes?: string[]; /** How many files the session changed (a count, not paths). */ files?: number;
}
export interface LogResult { ok: boolean; count: number; rows: LogRow[] }
export interface LogOptions {
  domain?: string; project?: string; since?: string; until?: string; note?: string; type?: string; event?: string; limit?: number;
}
export function logArgs(o: LogOptions): string[] {
  const argv = ["log"];
  if (o.domain) argv.push("--domain", o.domain);
  if (o.project) argv.push("--project", o.project);
  if (o.since) argv.push("--since", o.since);
  if (o.until) argv.push("--until", o.until);
  if (o.note) argv.push("--note", o.note);
  if (o.type) argv.push("--type", o.type);
  if (o.event) argv.push("--event", o.event);
  if (o.limit) argv.push("--limit", String(o.limit));
  return view(argv);
}
export const log = (o: LogOptions = {}) => run<LogResult>(logArgs(o));

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
export const writeSystem = (action: "create" | "update" | "retire", payload: SystemCreate | SystemUpdate | { slug: string }) =>
  direct(["system", action], payload);

// ---- Changes (an LM that has the `changes` command). ----

export const STAGES = ["explore", "design", "implement", "validate"] as const;
export type ChangeStage = (typeof STAGES)[number];
export type ChangeStatus = "active" | "done" | "cancelled";

/** One row of `changes`: the registry entry plus `display`, `brief_status` and `actions`. */
export interface Change {
  id: number; display: string; title: string; project: string;
  /** `domain:id` of the brief where it lives now. */
  brief: string;
  stage: ChangeStage; status: ChangeStatus;
  repo: string | null; branch: string | null; system: string | null; element: string | null;
  created: string; updated: string;
  /** The brief note's status, whatever it is: an archived or superseded note still resolves and reports that status.
   *  Null only when no note with the brief's id exists any more (deleted, or the stored ref is broken). */
  brief_status: Status | null;
  actions: { open: number; done: number };
}
export interface ChangesResult { ok: boolean; changes: Change[]; warnings: string[] }

export interface ChangeCreate {
  project: string; title: string;
  /** A new brief to write, or the ref of an existing active plan note to adopt. */
  brief: { domain?: string; title?: string; body: string } | string;
  stage?: ChangeStage; repo?: string | null; branch?: string | null; system?: string | null; element?: string | null;
}
export interface ChangeUpdate {
  id: number | string; title?: string; stage?: ChangeStage; status?: ChangeStatus;
  repo?: string | null; branch?: string | null; system?: string | null; element?: string | null;
}
export interface ChangeClose { id: number | string; status?: "done" | "cancelled" }
export interface ChangeSummary {
  id: number; display: string; title: string; fields: string[]; files: number;
  brief?: string; adopted?: boolean; brief_action?: "resolve" | "reopen" | null;
}
export type ChangeReceipt = Receipt & { summary: ChangeSummary };

export const changesArgs = (o: { status?: ChangeStatus | "any"; project?: string } = {}) =>
  view(["changes", ...(o.status ? ["--status", o.status] : []), ...(o.project ? ["--project", o.project] : [])]);
export const changes = (o: { status?: ChangeStatus | "any"; project?: string } = {}) => run<ChangesResult>(changesArgs(o));
export const writeChange = (action: "create" | "update" | "close", payload: ChangeCreate | ChangeUpdate | ChangeClose) =>
  direct(["change", action], payload) as Promise<ChangeReceipt>;
/** Append one open Action Item; the rest of the body is kept. */
export const addAction = (ref: string, text: string) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), "--add-action", text]);

// ---- Note views (an LM that has the `views` command): a note kept as an HTML dashboard. ----

/** One row of `views`: a registered view and the state of its local page and published copy. */
export interface ViewRow {
  /** The note's ID (not a ref): the ref is `${domain}:${note}`. */
  note: string; domain: string;
  /** The view's short title. */
  title: string | null;
  /** Null when the note no longer exists. */
  note_title: string | null;
  /** Absolute path of the local HTML page. */
  path: string; fresh: boolean; artifact_url: string | null; artifact_current: boolean; exists: boolean;
}
export interface ViewsResult { ok: boolean; views: ViewRow[] }

export interface ViewItem { index: number; done: boolean; text: string; tags: string[]; id: string | null; detail: string | null }
/** The model `views render --format json` prints: what the HTML page and Hivemind's dashboard both draw. */
export interface ViewModel {
  id: string; domain: string; title: string; type: string; status: string; updated: string; revision: string;
  summary: string; important: string | null; items: ViewItem[]; sections: { heading: string; text: string }[];
  counts: { open: number; done: number; total: number };
  /** The replacing note's title, else its short ID. */
  superseded_by: string | null; view_title?: string;
}

export const viewRef = (v: Pick<ViewRow, "domain" | "note">) => `${v.domain}:${v.note}`;
export const views = () => run<ViewsResult>(view(["views", "--all-domains"]));
export const viewModel = (ref: string) =>
  run<{ ok: boolean; model: ViewModel }>(view(["views", "render", ref, "--format", "json", "--domain", domainOf(ref)])).then((r) => r.model);
export interface ViewWriteResult { ok: true; note: string; domain?: string; title?: string; path?: string; status: string; operation_id?: string }
/** Register a view (the page is rendered at once). Without a title LM uses the note's own. */
export const addView = (ref: string, title?: string) =>
  run<ViewWriteResult>(["views", "add", ref, "--domain", domainOf(ref), ...(title ? ["--title", title] : [])]);
export const removeView = (ref: string) => run<ViewWriteResult>(["views", "remove", ref, "--domain", domainOf(ref)]);

// ---- Recap (LM `recap` command). ----

export type RecapGroup = "created" | "updated" | "resolved" | "superseded" | "archived" | "restored" | "deleted";
export interface RecapChange { ref: string; title: string | null; type: string | null; summary: string | null; actor: string | null; time: string; count: number }
export interface Recap {
  ok: boolean; since: string; until: string; days: number; domains: string[];
  counts: Record<string, number>;
  changes: Partial<Record<RecapGroup, RecapChange[]>>;
  maintenance: {
    runs: number; reviewed: number; kept: number; deferred: number; updated: number; confirmed: number; retired: number; charged_usd: string;
    retired_notes: { ref: string; action: string; rule?: string | null; reason?: string | null; title?: string | null }[];
  };
  sessions: { count: number; by_harness: Record<string, number>; notes_saved: number };
  open_work: { notes: number; items: number; top: { ref: string; title: string; open: number }[] };
  review: { due: number; by_kind: Record<string, number> };
  markdown: string;
}
export interface RecapOptions { days?: number; project?: string }
/** Hivemind has no bound domain, so recap always covers every domain; a project narrows it. */
export function recapArgs(o: RecapOptions): string[] {
  const argv = ["recap", "--all-domains"];
  if (o.days) argv.push("--days", String(o.days));
  if (o.project) argv.push("--project", o.project);
  return view(argv);
}
export const recap = (o: RecapOptions = {}) => run<Recap>(recapArgs(o));

// ---- Maintenance: automatic note review, and the two writes it makes possible on a note. ----

export interface MaintenanceRun {
  id: string; status: string; day: string; attempted_at: string; finished_at: string | null; reason_code: string | null;
  model: string; reviewed: number; charged_usd: string; cost_complete: boolean;
  updated: number; confirmed: number; archived: number; superseded: number; resolved: number;
  kept: number; deferred: number; skipped: number; distinct: number;
}
export interface MaintenanceStatus {
  ok: boolean; enabled: boolean; domains: string[]; policy_version: number; config_revision: string;
  limits: { model: string; max_notes_per_day: number; timeout_seconds: number; daily_budget_usd: string; min_interval_seconds: number };
  enabled_at: string | null;
  /** null when LM could not read the accounting files; `errors` then says why. */
  accounting: { day: string; reviewed: number; reserved_notes: number; reserved_usd: string; charged_usd: string; cost_complete: boolean } | null;
  blocked: { reason: string; config_revision?: string } | null; running: boolean; eligible: boolean; next_eligible_at: string | null; skip_reason: string | null;
  last_run: MaintenanceRun | null; errors: string[];
}
export interface MaintenanceDecision {
  ref: string; action: string; result: string; reason_code: string | null; operation_id: string | null;
  rule: string | null; reason: string | null;
}
export interface MaintenanceRunDetail { ok: boolean; run: MaintenanceRun; selected: string[]; decisions?: MaintenanceDecision[] }

export const maintenanceStatus = () => run<MaintenanceStatus>(view(["maintenance", "status"]));
export const maintenanceHistory = (limit?: number) =>
  run<{ ok: boolean; runs: MaintenanceRun[] }>(view(["maintenance", "history", ...(limit ? ["--limit", String(limit)] : [])]));
export const maintenanceRun = (id: string) => run<MaintenanceRunDetail>(view(["maintenance", "history", "--run", id]));
/** Turn maintenance on and add one domain to the ones it covers. The domain is always named: without --domain, LM would take it from the server's folder. */
export const maintenanceEnable = (domain: string) =>
  run<MaintenanceStatus & { operation_id?: string }>(["maintenance", "enable", "--domain", domain]);
export const maintenanceDisable = () => run<MaintenanceStatus & { operation_id?: string }>(["maintenance", "disable"]);

/** Bring an archived note back to active; LM pins it so maintenance does not retire it again at once. */
export const restoreNote = (ref: string) => run<WriteResult>(["restore", ref, "--domain", domainOf(ref)]);
export const setPin = (ref: string, on: boolean) => run<WriteResult>(["update", ref, "--domain", domainOf(ref), on ? "--pin" : "--unpin"]);
/** A rule note is shown in full at every session start. LM refuses the flag on types other than policy and preference. */
export const ruleAllowed = (type: string | undefined) => type === "policy" || type === "preference";
export const setRule = (ref: string, on: boolean) => run<WriteResult>(["update", ref, "--domain", domainOf(ref), on ? "--rule" : "--no-rule"]);

/** The domain wiki (`wiki --format json`): every note as an article, grouped into projects, sections and a code-folder tree.
 *  Notes carry their id; `ref` is the 8-character prefix used in page addresses; folder ids are `c-` plus a hash of project and path, stable across rebuilds. */
export interface WikiNote {
  id: string; ref: string; title: string; type: string; status: string; retired?: boolean; tags: string[]; files: string[];
  updated: string; created: string; lead: string; body: string; out: string[]; backlinks: string[];
  project: string; section: string; folder: string | null; filename: string | null;
}
export interface WikiProject {
  slug: string; name: string; description: string; aliases: string[]; repos: string[]; status: string; charter: string | null;
  /** Per section key: its note ids, or for `code` its root folder ids. */
  sections: Record<string, { notes?: string[]; folders?: string[]; count: number }>;
  count: number; updated: string; briefs: string[]; maps: string[];
}
export interface WikiFolder { id: string; project: string; name: string; path: string; parent: string | null; folders: string[]; notes: string[]; count: number }
export interface WikiSection { key: string; label: string; blurb: string }
export interface WikiModel {
  domain: string; generated: string; renderer: number; archived: boolean;
  notes: WikiNote[]; projects: WikiProject[]; folders: WikiFolder[]; sections: WikiSection[];
  /** Notes in other domains that this domain's links name, by casefolded title. */
  external: Record<string, { title: string; domain: string }>;
}
export const wikiModel = (domain: string, o: { archived?: boolean } = {}) =>
  run<{ ok: boolean; model: WikiModel }>(view(["wiki", "--format", "json", "--domain", domain, ...(o.archived ? ["--archived"] : [])])).then((r) => r.model);
