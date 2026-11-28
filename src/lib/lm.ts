// Typed wrappers over the Living Memory CLI, reached through the Rust bridge (`serve --stdio`).
// Reads run as the viewer actor: read-only, and they leave no usage-diary events.
import { invoke } from "@tauri-apps/api/core";
import { logLmFailure } from "./log";

/** Living Memory's own note types. A store can define more (`types`), so a note's type is any string. */
export const BUILTIN_TYPES = [
  "knowledge", "decision", "preference", "context", "status",
  "bug", "plan", "risk", "research", "policy", "map", "runbook", "brief",
] as const;
export type NoteType = string;
export const isBuiltinType = (type: string) => (BUILTIN_TYPES as readonly string[]).includes(type);
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

/** `REF@REVISION`: how a command names another note it writes (a superseded note, a successor, a merge's notes), with the
 *  revision the caller read. Living Memory refuses a write to an existing note without one (`revision_required`). */
export const at = (ref: string, revision: string) => `${ref}@${revision}`;
/** The revision of the note a command names, as Living Memory takes it. */
const expected = (revision: string) => ["--expected-revision", revision];

export type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
let call: Invoke = invoke as Invoke;
/** Tests swap the transport. */
export function setTransport(fn: Invoke) { call = fn; }

/** The bridge generation `connect` reported. Every `doc` request carries it, and Rust refuses one made before the bridge
 *  switched stores, checked under the lock that picks the process (Codex re-review of 75ce884, R2-D1). */
let generation: number | undefined;
export function setBridgeGeneration(next: number | undefined) { generation = next; }
export const bridgeGeneration = () => generation;
/** `at`: the generation an action began in, so work it does after waiting is still refused in another store (Codex
 *  review of dd4c1b0, R3-D1). Any command given an `at` is bound to it, not only `doc` ones: a note save carries the
 *  generation its base was read in (Codex review of 7320d7f, LM-2). */
const bound = (argv: string[], at?: number) => {
  const g = at ?? generation;
  return (argv[0] === "doc" || argv[0] === "proposals" || at !== undefined) && g !== undefined ? { generation: g } : {};
};

/** The error for a failed command. It is logged with the command and what it failed with, never the arguments: they hold
 *  note text and search terms. */
function failure(argv: string[], reply: Reply): LmError {
  const error = reply.error ?? { code: "invalid", message: `Exit code ${reply.exit_code}` };
  // The command, its code and its exit status, nothing of the message: it can quote note titles, note text or a suspected
  // credential, and the log goes into Copy diagnostics.
  logLmFailure(argv[0], error.code, reply.exit_code);
  return new LmError(error.code, error.message, reply.exit_code);
}

export async function run<T>(argv: string[], stdin?: string, at?: number): Promise<T> {
  const reply = (await call("lm", { argv, stdin: stdin ?? null, ...bound(argv, at) })) as Reply<T>;
  if (reply.exit_code !== 0) throw failure(argv, reply);
  return reply.result;
}

const view = (argv: string[]) => [...argv, "--actor", "viewer"];

/** What `version` reports under `capabilities`. */
export interface Capabilities {
  direct_writes?: number; history?: number; restore?: number; pin?: number; rule?: number; maintenance?: { version: number; actions: string[] };
  wiki_agent?: { version: number }; note_types?: number;
  /** 1: project brands (`project update` takes `brand`) and the store default brand (`config set brand`). */
  brand?: number;
  /** 1: `proposals` lists, shows, accepts and rejects staged notes and page edits (it replaced `doc proposals`, `doc accept` and `doc reject`). */
  proposals?: number;
  /** 2: `open` supports `--pages none|injectable|searchable` and returns `kind: "note" | "page"`. */
  items?: { fields?: number };
  /** 1: a system has a `project` field. */
  systems?: { project?: number };
  /** 2: `views` also holds query views (`kinds` lists `note` and `query`); a row without `kind` is a note view. */
  views?: { version: number; kinds: string[] };
  /** 1: every write to an existing note needs the revision the caller read (`--expected-revision`, `REF@REVISION`). */
  revisions?: number;
  /** Folder notebook pages: `doc read --file` and `doc propose --file`, and the proposals Living Memory stages for them. */
  docs?: { version: number; max_page_bytes: number; folder_policy?: boolean | number; accept_edited?: boolean;
    /** 1: `doc read --file` and `doc propose --file` for folder notebook pages, and folder proposals in `proposals`. */
    folder_proposals?: number };
}

export interface ConnectInfo {
  version: { api: number; python: string; commands: string[]; capabilities?: Capabilities };
  root: string;
  program: string;
  script: string;
  /** The signed-in OS user, when the system reports one. */
  user?: string | null;
  /** The bridge generation this connection is for (R2-D1). */
  generation?: number;
}
export interface Settings {
  python: string | null; script: string | null; root: string | null;
  capture_shortcut?: string | null; close_to_tray?: boolean | null;
  claude_path?: string | null; codex_path?: string | null; agent_budget_usd?: number | null; architecture_suite_plugin?: string | null;
  /** Folders chosen with the native picker; read-only here, Rust ignores it on save. */
  other_folders?: string[] | null;
  /** Commands agent sessions may run without asking, per project slug. Rust checks each one. */
  allowed_commands?: Record<string, string[]> | null;
  /** Whether finished sessions are reviewed for knowledge and skills (default on), and the daily cap of the reviewer and the executive calls. */
  learning_reviewer?: boolean | null; learning_daily_usd?: number | null;
  /** The daily cap of the sessions and wiki rebuilds automations start. */
  automation_daily_usd?: number | null;
  /** The most one reviewer call, and each executive call by name, may spend. */
  review_call_usd?: number | null; executive_call_usd?: Record<string, number> | null;
  /** Whether reviewed patches to a well-used skill are published without asking (default off). */
  skills_auto_patch?: boolean | null;
  /** An architecture-rules/v1 file per system slug, for the drift check. */
  architecture_rules?: Record<string, string> | null;
  /** Engines hidden from the interface; Rust refuses a save that hides both. */
  hidden_engines?: ("claude" | "codex")[] | null;
  /** Run Claude calls although Claude Code managed policy is deployed (default off); managed hooks then run in them. */
  claude_under_managed_policy?: boolean | null;
}
export interface CaptureStatus { shortcut: string | null; error: string | null; close_to_tray: boolean }

export const connect = () => call("connect", {}) as Promise<ConnectInfo>;
/** End the Living Memory process, so the next request starts a new one: an explicit reconnect then reaches a Living Memory
 *  upgraded in place (same interpreter, script and store), which `connect` alone would not restart (Codex review of e30902f, C2). */
export const restartBridge = () => call("bridge_restart", {}) as Promise<void>;
/** What the connected Living Memory reports about itself, for a window that has no connection of its own (quick capture). */
export const lmVersion = () => run<ConnectInfo["version"]>(["version"]);
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
  const argv = ["search"];
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
/** The most of a note's body `read` returns: Living Memory caps `--max-chars` at 64,000 and has no way to read the rest
 *  (`truncated` is true then). Text read at the cap is never a base for a write: a body sent back replaces the whole body. */
export const LM_READ_LIMIT = 64000;
/** LM's own default is 16,000 characters; Hivemind asks for the most it allows. */
export const read = (ref: string, opts: { domain?: string; maxChars?: number } = {}) =>
  run<Note>(view(["read", ref, "--max-chars", String(opts.maxChars ?? LM_READ_LIMIT), ...(opts.domain ? ["--domain", opts.domain] : [])]));

/** Properties only (no body): cheap, for origins and titles. */
export const meta = (ref: string) => run<Omit<Note, "body" | "truncated">>(view(["read", ref, "--metadata-only"]));

export interface SearchHit {
  id: string; domain: string; title: string; type: NoteType; updated: string; tags: string[];
  status: Status; snippet: string; score: number; rank: number; engine: string; revision: string;
  sourceField: string; sourceScope: "active" | "global" | "foreign"; similarity?: number;
  /** 0 for a note that only filled the list up; absent in older Living Memory versions. */
  relevance?: number;
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

/** One note type as `types` reports it: built-ins first, then the store's own. `summary` is the template's first line. */
export interface NoteTypeDef {
  name: string; builtin: boolean; status: "active" | "retired"; description: string; summary: string;
  sections: string[]; actions: boolean; review_days: number | null; concern: string | null; subject: string | null;
  created?: string | null; updated?: string | null;
}
/** With `all`, retired custom types are listed too. */
export const noteTypes = (all = false) =>
  run<{ ok: boolean; types: NoteTypeDef[]; warnings: string[] }>(view(["types", ...(all ? ["--all"] : [])]));

/** The domain part of a `domain:id` ref. */
export const domainOf = (ref: string) => ref.slice(0, ref.indexOf(":"));

// ---- Writes (main actor). Every write is journaled by LM; Hivemind logs the operation IDs it caused. ----

export interface WriteResult {
  ok: true; operation_id?: string; state?: string; id: string; status: string; domain?: string; ref?: string;
  quality_warnings?: string[]; similar?: { ref: string; title: string }[]; inferred_tags?: string[];
  redacted?: { kind: string; field: string }[]; warning?: string; hint?: string;
  /** The new revision of each note the write changed, by `domain:id`. */
  revisions?: Record<string, string>;
}

/** Fields `update` accepts; send only the ones that changed. */
export interface UpdatePayload {
  title?: string; body?: string; tags?: string[]; type?: NoteType; context?: string;
  review_by?: string | null; files?: string[];
  /** The revision of the note the change was made on; Living Memory refuses the write without it. */
  expected_revision: string;
}
/** `at`: the bridge generation the note's base was read in; Rust refuses the write if the bridge has switched stores since. */
export const update = (ref: string, payload: UpdatePayload, opts: { redact?: boolean; at?: number } = {}) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), ...(opts.redact ? ["--redact"] : [])], JSON.stringify(payload), opts.at);

export interface CapturePayload {
  title: string; body: string; tags: string[]; type: NoteType; context?: string; review_by?: string;
  files?: string[];
  /** Notes this one replaces, each as `REF@REVISION` (`at`). */
  supersedes?: string[]; allow_similar?: boolean; origin?: string;
  /** The same key, title and body again returns the first note (`status: "existing"`) instead of a second one. */
  idempotency_key?: string;
}
/** Hivemind's own captures carry this origin (LM sets `<harness>:<hash>` only for agent sessions). */
export const ORIGIN = "hivemind:local";
export const capture = (domain: string, payload: CapturePayload, opts: { redact?: boolean } = {}) =>
  run<WriteResult>(["capture", "--domain", domain, ...(opts.redact ? ["--redact"] : [])], JSON.stringify({ origin: ORIGIN, ...payload }));

// ---- Proposals: drafts agents (and Hivemind's reviewer) staged for the user to accept or reject. One command, `proposals`,
// covers staged notes (8 hex digit IDs) and page edits (12); the length of the ID tells them apart. ----
export interface MemoryProposal { kind?: "note"; id: string; status: string; created: string; domain: string; type: NoteType; title: string; note_ref?: string; reason?: string }
export interface MemoryProposalDetail {
  id: string; status: string; created: string; domain: string; warnings?: string[];
  note: { title: string; body: string; type?: NoteType; tags?: string[]; context?: string };
}
export const proposalsList = () => run<{ ok: boolean; proposals: MemoryProposal[] }>(view(["proposals", "list", "--kind", "note"]));
export const proposalShow = (id: string) => run<{ kind: "note"; proposal: MemoryProposalDetail }>(view(["proposals", "show", id])).then((r) => r.proposal);
/** Save the draft as staged, into the domain it was proposed for. */
export const proposalAccept = (id: string) => run<WriteResult>(["proposals", "accept", id]);
/** Save a draft that has no concern tag the store knows (Living Memory refuses those), with the one the user picked: `capture` takes the whole note beside the ID. */
export const proposalAcceptWith = (id: string, note: { title: string; body: string; type?: NoteType }, concern: string) =>
  run<WriteResult>(["capture", "--from-proposal", id, "--type", note.type ?? "knowledge", "--concern", concern, note.title, note.body]);
export const proposalReject = (id: string, reason?: string) => run<{ ok: boolean }>(["proposals", "reject", id, ...(reason ? ["--reason", reason] : [])]);

// Every write to an existing note below takes `revision`: the revision of the note as the UI shows it. A note changed since
// fails with `stale` (exit 6); the caller reads it again and lets the user repeat the action (`lib/stale.ts`).

export const check = (ref: string, index: number, done: boolean, revision: string) =>
  run<WriteResult & { item: string; index: number; done: boolean; open: number }>(
    ["check", ref, "--index", String(index), "--domain", domainOf(ref), ...(done ? [] : ["--undo"]), ...expected(revision)]);

export const confirm = (ref: string, revision: string) =>
  run<WriteResult & { confirmed?: string[]; review_by?: string }>(["confirm", ref, "--domain", domainOf(ref), ...expected(revision)]);

/** Append one open Action Item; the rest of the body is kept. */
export const addAction = (ref: string, text: string, revision: string) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), "--add-action", text, ...expected(revision)]);

// ---- Direct writes: one journaled step. The receipt names the operation, so it can be undone. ----

/** `kind` and `summary` are absent from the receipt of a note write such as archive. */
export interface Receipt {
  ok: true; operation_id: string; state: string; kind?: string; summary?: Record<string, unknown>; undo: string; warnings?: string[];
  /** The new revision of each note the write changed, by `domain:id`. */
  revisions?: Record<string, string>;
}

const direct = (argv: string[], payload?: object) => run<Receipt>(argv, payload ? JSON.stringify(payload) : undefined);

export const archiveNote = (ref: string, revision: string) => direct(["archive", ref, "--domain", domainOf(ref), ...expected(revision)]);
export const resolveNote = (ref: string, revision: string) => direct(["resolve", ref, "--domain", domainOf(ref), ...expected(revision)]);
export const reopenNote = (ref: string, revision: string) => direct(["reopen", ref, "--domain", domainOf(ref), ...expected(revision)]);
/** `by` is a note in the same domain, with the revision it was picked at. */
export const supersedeNote = (ref: string, revision: string, by: { ref: string; revision: string }) =>
  direct(["supersede", ref, "--by", at(by.ref, by.revision), "--domain", domainOf(ref), ...expected(revision)]);
/** Delete a note file. Journaled, so `undo` brings it back. */
export const deleteNote = (ref: string, revision: string) => direct(["delete", ref, "--domain", domainOf(ref), ...expected(revision)]);
/** `target` takes `body`; the `sources` are superseded by it. Each note is `REF@REVISION` (`at`). */
export interface MergePayload { target: string; sources: string[]; body: string }
export const merge = (payload: MergePayload) => direct(["merge"], payload);
/** Rename tags in every domain, `{ "old/tag": "new/tag" }`. A bulk retag needs no note revisions. */
export const retag = (mappings: Record<string, string>) => direct(["retag"], mappings);
export const taxonomyAdd = (tags: string[]) => direct(["taxonomy", "add", ...tags]);

export interface NoteTypeCreate {
  name: string; description: string; summary?: string; sections?: string[]; actions?: boolean;
  review_days?: number | null; concern?: string | null; subject?: string | null;
}
export type NoteTypeUpdate = Partial<Omit<NoteTypeCreate, "name">> & { name: string; status?: "active" | "retired" };
export const typeWrite = (action: "create" | "update" | "retire", payload: NoteTypeCreate | NoteTypeUpdate | { name: string }) =>
  direct(["type", action], payload);

/** Undo one operation: one more direct, journaled step. Refused when the files were edited again since. */
export const undo = (operationId: string) => run<Receipt>(["undo", operationId]);

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
  run<LinkGraph>(view(["search", "--links", ...(o.allDomains ? ["--all-domains"] : ["--domain", o.domain ?? ""]), "--status", o.status ?? "any"]));

// ---- Projects, open work, review and timeline (LM api 2). ----

export type ProjectStatus = "active" | "paused" | "archived";
/** A wiki brand. A written `name` of none means the project's own name; `logo` is a file path in a write and a store path in a read. */
export interface Brand { name?: string; logo?: string }
export interface Project {
  slug: string; name: string; status: ProjectStatus; repos: string[]; aliases: string[]; description: string;
  charter: string | null; created: string; updated: string; tag: string; tag_registered: boolean;
  brand?: Brand;
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
  /** Missing `name` is no name, missing `logo` keeps the logo, `logo: null` removes it and `brand: null` removes the whole brand. */
  brand?: (Omit<Brand, "logo"> & { logo?: string | null }) | null;
}
export const writeProject = (action: "create" | "update" | "archive", payload: ProjectCreate | ProjectUpdate | { slug: string }) =>
  direct(["project", action], payload);

/** The store default brand, or null when none is set. */
export const defaultBrand = async () => (await run<{ settings: { brand: { value: Brand | null } } }>(view(["config", "get", "brand"]))).settings.brand.value;
/** Set the default brand (it needs a name; a logo is kept unless `logo: null`), or remove it with null. */
export const setDefaultBrand = (brand: (Omit<Brand, "logo"> & { logo?: string | null }) | null) => run<Receipt>(["config", "set", "brand", JSON.stringify(brand)]);

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

export interface OpenItem { kind?: "note" | "page"; ref: string; short_ref: string; title: string; type: NoteType; updated: string; index: number; item: string; revision?: string }
export interface OpenWork { ok: boolean; domain: string | null; notes: number; count: number; items: OpenItem[]; hint?: string }
export interface OpenOptions extends ScopeOptions { pages?: "none" | "injectable" | "searchable" }
export const openArgs = (o: OpenOptions) => {
  const argv = scopeArgs("open", o);
  if (o.pages) argv.splice(argv.length - 2, 0, "--pages", o.pages);
  return argv;
};
export const openWork = (o: OpenOptions) => run<OpenWork>(openArgs(o));

export interface ReviewRow {
  ref: string; title: string; type: NoteType; updated: string;
  review_by?: string; confirmed?: string; revision?: string; domain?: string;
  /** From the richer worklist only; older stores send none of these. */
  kinds?: ReviewKind[]; reason?: string; action?: ReviewAction; pair?: { ref: string; title: string; score: number };
}
export const REVIEW_KINDS = ["stale", "due", "interim", "duplicate", "warned", "noisy"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export type ReviewAction = "confirm" | "update" | "supersede" | "resolve" | "merge" | "archive";
export interface ReviewResult {
  ok: boolean; domain: string | null; due: number; notes: ReviewRow[]; hint?: string;
  counts?: Record<ReviewKind, number>;
}
export const reviewArgs = (o: ScopeOptions) => scopeArgs("review", o);
export const review = (o: ScopeOptions) => run<ReviewResult>(reviewArgs(o));

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

// ---- Systems (an LM that has the `systems` command). ----

export type SystemStatus = "active" | "deprecated" | "retired";
export interface System {
  slug: string; name: string; status: SystemStatus; description: string; owners: string[]; capabilities: string[];
  repos: string[]; depends_on: string[]; architecture: string | null; passport: string | null;
  /** The project slug the system belongs to; null or absent when none is set. */
  project?: string | null;
  created: string; updated: string; tag: string; tag_registered: boolean; dependents: string[];
}
export interface SystemsResult { ok: boolean; systems: System[]; warnings: string[] }
export const systemsArgs = (o: { status?: SystemStatus | "any" } = {}) => view(["systems", ...(o.status ? ["--status", o.status] : [])]);
export const systems = (o: { status?: SystemStatus | "any" } = {}) => run<SystemsResult>(systemsArgs(o));

export interface SystemCreate {
  slug: string; name: string; description?: string; owners?: string[]; capabilities?: string[]; repos?: string[];
  depends_on?: string[]; architecture?: string | null; project?: string | null; passport: { domain?: string; title?: string; body: string };
}
export interface SystemUpdate {
  slug: string; name?: string; description?: string; status?: SystemStatus; owners?: string[]; capabilities?: string[];
  repos?: string[]; depends_on?: string[]; architecture?: string | null; project?: string | null; passport?: string;
}
export const writeSystem = (action: "create" | "update" | "retire", payload: SystemCreate | SystemUpdate | { slug: string }) =>
  direct(["system", action], payload);

// ---- Views (an LM that has the `views` command): a note kept as an HTML dashboard, and from `capabilities.views` 2 a saved page query. ----

/** A note view: a registered note and the state of its local page and published copy. */
export interface NoteView {
  kind: "note";
  /** The note's ID (not a ref): the ref is `${domain}:${note}`. */
  note: string; domain: string;
  /** The view's short title. */
  title: string | null;
  /** Null when the note no longer exists. */
  note_title: string | null;
  /** Absolute path of the local HTML page. */
  path: string; fresh: boolean; artifact_url: string | null; artifact_current: boolean; exists: boolean;
}
/** A query view: a page query (table or board) that Hivemind runs over its own index; Living Memory only stores it. `spec` is what it
 *  stored (it checked the rules of `parseSpec`, but an older one may differ), so read it with `parseSpec`. */
export interface QueryView { kind: "query"; id: string; title: string; spec: unknown; added: string }
export type ViewRow = NoteView | QueryView;
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

export const viewRef = (v: Pick<NoteView, "domain" | "note">) => `${v.domain}:${v.note}`;
/** What names a view in the route: a note view's ref, a query view's ID. */
export const viewKey = (v: ViewRow) => (v.kind === "query" ? v.id : viewRef(v));
/** An LM before views version 2 sends rows without `kind`: they are note views. */
export const views = () =>
  run<ViewsResult>(view(["views", "--all-domains"])).then((r) => ({ ...r, views: r.views.map((v) => ((v as { kind?: string }).kind ? v : ({ ...v, kind: "note" } as ViewRow))) }));
export const viewModel = (ref: string) =>
  run<{ ok: boolean; model: ViewModel }>(view(["views", "render", ref, "--format", "json", "--domain", domainOf(ref)])).then((r) => r.model);
export interface ViewWriteResult { ok: true; note: string; domain?: string; title?: string; path?: string; status: string; operation_id?: string }
/** Register a view (the page is rendered at once). Without a title LM uses the note's own. */
export const addView = (ref: string, title?: string) =>
  run<ViewWriteResult>(["views", "add", ref, "--domain", domainOf(ref), ...(title ? ["--title", title] : [])]);
export interface QueryViewWriteResult { ok: true; kind: "query"; id: string; title: string; status: string; operation_id?: string }
const isQueryId = (key: string) => /^q-[0-9a-f]{8}$/.test(key);
/** Drop a view: a note view by its ref, a query view by its ID. */
export const removeView = (key: string) =>
  run<ViewWriteResult | QueryViewWriteResult>(["views", "remove", key, ...(isQueryId(key) ? [] : ["--domain", domainOf(key)])]);
/** Save a query view. Living Memory reads the query from a file only, so the JSON goes through a staged `--spec-file`. Needs `capabilities.views` 2. */
export const addQueryView = (title: string, spec: object) =>
  runBody<QueryViewWriteResult>(["views", "add", "--title", title], JSON.stringify(spec), "--spec-file");
export const updateQueryView = (id: string, spec: object, title?: string) =>
  runBody<QueryViewWriteResult>(["views", "update", id, ...(title ? ["--title", title] : [])], JSON.stringify(spec), "--spec-file");

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
export const restoreNote = (ref: string, revision: string) => run<WriteResult>(["restore", ref, "--domain", domainOf(ref), ...expected(revision)]);
export const setPin = (ref: string, on: boolean, revision: string) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), on ? "--pin" : "--unpin", ...expected(revision)]);
/** A rule note is shown in full at every session start. LM refuses the flag on types other than policy and preference. */
export const ruleAllowed = (type: string | undefined) => type === "policy" || type === "preference";
export const setRule = (ref: string, on: boolean, revision: string) =>
  run<WriteResult>(["update", ref, "--domain", domainOf(ref), on ? "--rule" : "--no-rule", ...expected(revision)]);

/** The domain wiki (`wiki --format json`): every note as an article, grouped into projects, sections and a code-folder tree.
 *  Notes carry their id; `ref` is the 8-character prefix used in page addresses; folder ids are `c-` plus a hash of project and path, stable across rebuilds. */
export interface WikiNote {
  id: string; ref: string; title: string; type: string; status: string; retired?: boolean; tags: string[]; files: string[];
  updated: string; created: string; lead: string; body: string; out: string[]; backlinks: string[];
  project: string; section: string; folder: string | null; filename: string | null;
  /** Agent edition only: the page's build details and sources. Source notes (section `sources`) have none. */
  page?: WikiPageInfo;
}
/** A note an agent-written page cites: `current` is false when its revision moved on since the page was written, `missing` when it was archived or deleted. */
export interface WikiPageSource { id: string; ref: string; title: string; type: string; current: boolean; missing: boolean }
export interface WikiPageInfo {
  purpose: string; written: boolean; stale: boolean; built: string | null; model: string | null; cost_usd: number; warnings: string[];
  /** `[^k]` in the body cites `sources[k - 1]`. */
  sources: WikiPageSource[];
}
export interface WikiBuild {
  built: string; model: string; cost_usd: number; pages: number; written: number; stale: number; pending: number; complete: boolean;
  omitted: { id: string; title: string; reason: string }[];
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
  /** `"agent"` for the agent-written edition, which has the two keys below; the structured one has none. */
  edition?: "agent"; scope?: string; build?: WikiBuild;
}
export const wikiModel = (domain: string, o: { archived?: boolean } = {}) =>
  run<{ ok: boolean; model: WikiModel }>(view(["wiki", "--format", "json", "--domain", domain, ...(o.archived ? ["--archived"] : [])])).then((r) => r.model);

/** Living Memory's reply when no agent-written edition has been built for the scope yet. */
export const isNoAgentWiki = (e: unknown) => e instanceof LmError && /no agent wiki/i.test(e.message);
/** The saved agent-written edition of a domain (or of one project), in the same shape as the structured model. Null when none was built yet. */
export const agentWikiModel = (domain: string, project?: string) =>
  run<{ ok: boolean; model: WikiModel }>(view(["wiki", "--agent", "--format", "json", "--domain", domain, ...(project ? ["--project", project] : [])]))
    .then((r) => r.model, (e: unknown) => { if (isNoAgentWiki(e)) return null; throw e; });

// Folder notebook pages through Living Memory (NS-2A, NS-2B, CON-9): staged page edits, one page read by its file path, and the
// folder registry. Hivemind sees private folder notebooks (`--include-private`, its bridge only). Reads run as the viewer;
// writes as the main actor. Notebooks that kept their pages inside the store were retired by CON-18 (2026-11-24).
export type Visibility = "hidden" | "searchable" | "injectable";
/** What a `doc` write returns: the operation and, for a page write, the new revision. */
export interface DocReceipt { operation_id: string; revision?: string; path?: string; summary?: Record<string, unknown> }
/** A folder notebook's page read through Living Memory. */
export interface DocPage { domain: string; notebook: string; path: string; text: string; revision: string; size: number; updated: string; truncated?: boolean }
export interface DocProposalRow {
  id: string; domain: string; base_revision: string | null; note: string | null;
  created: string; status: "pending" | "accepted" | "rejected"; reason: string | null; settled: string | null; size: number;
  /** `notebook` is Living Memory's `nb-` id for the folder, `folder` the folder's canonical path, `path` the page's path inside it and
   *  `file` the page's full path. `orphaned`: the folder is no longer registered, so the edit can be rejected but not accepted. */
  notebook: string; path: string; folder: string; file?: string | null; orphaned?: boolean; applied?: boolean;
}
export interface DocProposal extends Omit<DocProposalRow, "reason" | "settled" | "size"> {
  body: string; session?: string | null;
  /** The proposal keeps the page as the agent read it (base64 of its bytes; null over 1 MiB), so the merge has its base. */
  base?: string | null;
}
/** The page as the agent read it, from a folder proposal's `base`: the bytes decoded as UTF-8, a byte order mark kept for `pageText`. */
export function decodeBase(base: string): string {
  const bytes = Uint8Array.from(atob(base), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

const PRIVATE = "--include-private";
/** A command that carries a page body: Rust sends it as stdin, or through a staging file when it is large (NS-2C). */
async function runBody<T>(argv: string[], body: string, flag?: "--spec-file"): Promise<T> {
  const reply = (await call("lm_body", { argv, body, ...(flag ? { flag } : {}), ...bound(argv) })) as Reply<T>;
  if (reply.exit_code !== 0) throw failure(argv, reply);
  return reply.result;
}

/** A `doc` command: options first, then `--` and the operands, so a path named `-Draft.md` is never read as an option
 *  (Codex review of 32fee20, C4). Free text goes as `--option=value` for the same reason. A command without operands gets no
 *  `--`: argparse refuses one where the command takes no positional arguments. */
function doc(action: string[], operands: string[], options: string[] = [], how: { viewer?: boolean; priv?: boolean } = {}) {
  return ["doc", ...action, ...options, ...(how.priv === false ? [] : [PRIVATE]), ...(how.viewer ? ["--actor", "viewer"] : []), ...(operands.length ? ["--", ...operands] : [])];
}

/** A Markdown page of a folder notebook, read by its file path (`doc read --file`, needs `docs.folder_proposals`): `notebook` is
 *  Living Memory's `nb-` id for the folder, `folder` its canonical path and `path` the page's path inside it. */
export interface DocFilePage extends DocPage { origin: "folder"; folder: string; file: string }
export const docReadFile = (file: string, at?: number) => run<DocFilePage>(doc(["read"], [], [`--file=${file}`], { viewer: true }), undefined, at);
/** A `proposals` command for page edits: the ID follows the action (an ID is hex, never an option), then the options. */
function proposals(action: string, id?: string, options: string[] = [], viewer = false) {
  return ["proposals", action, ...(id ? [id] : []), ...options, PRIVATE, ...(viewer ? ["--actor", "viewer"] : [])];
}
export const docProposals = (domain?: string, notebook?: string) =>
  run<{ proposals: DocProposalRow[] }>(proposals("list", undefined, ["--kind", "page", ...(domain ? ["--domain", domain] : []), ...(notebook ? [`--notebook=${notebook}`] : [])], true)).then((r) => r.proposals);
export const docProposal = (id: string) => run<{ proposal: DocProposal }>(proposals("show", id, [], true)).then((r) => r.proposal);
export const docAccept = (id: string) => run<DocReceipt>(proposals("accept", id));
/** Pending page edits of every folder notebook (`proposals list --kind page`), for the Inbox. */
export const allProposalsQuery = () => ({ queryKey: ["lm-proposals", "*"], queryFn: () => docProposals() });
/** Write the user's merge of a proposal and settle it as accepted, in one Living Memory operation, against the page's
 *  revision the merge was made from (null: the page must not exist). Needs `docs.accept_edited` (Codex review of
 *  32fee20, D3). */
export const docAcceptEdited = (id: string, body: string, expected: string | null) =>
  runBody<DocReceipt>(proposals("accept", id, ["--edited", ...(expected ? ["--expected-revision", expected] : [])]), body);
export const docReject = (id: string, reason?: string) => run<DocReceipt>(proposals("reject", id, reason ? [`--reason=${reason}`] : []));
/** Register a folder notebook outside the store, or change how far agents reach into it. A field left undefined keeps
 *  what Living Memory holds: a folder registered again keeps the visibility and private flag kept for it, and a new one
 *  is searchable (Codex review of 32fee20, P1). */
export const docFolderSet = (path: string, domain: string, change: { visibility?: Visibility; private?: boolean } = {}) =>
  run<unknown>(doc(["folder", "set"], [path], [
    "--domain", domain,
    ...(change.visibility ? ["--visibility", change.visibility] : []),
    ...(change.private === undefined ? [] : [change.private ? "--private" : "--no-private"]),
  ], { priv: false }));
/** Living Memory forgets a folder notebook; a hidden or private one stays out of reach. */
export const docFolderUnset = (path: string) => run<unknown>(doc(["folder", "unset"], [path], [], { priv: false }));
