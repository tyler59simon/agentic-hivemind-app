// Typed wrappers over the Living Memory CLI, reached through the Rust bridge (`serve --stdio`).
// Reads run as the viewer actor: read-only, and they leave no usage-diary events.
import { invoke } from "@tauri-apps/api/core";

export const NOTE_TYPES = [
  "knowledge", "decision", "preference", "context", "status",
  "bug", "plan", "risk", "research", "policy",
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
  version: { api: number; python: string; commands: string[] };
  root: string;
  program: string;
  script: string;
}
export interface Settings { python: string | null; script: string | null; root: string | null }

export const connect = () => call("connect", {}) as Promise<ConnectInfo>;
export const getSettings = () => call("get_settings", {}) as Promise<Settings>;
export const saveSettings = (value: Settings) => call("save_settings", { value }) as Promise<void>;

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
}
export interface ListPage { domains: string[]; total: number; offset: number; notes: NoteRow[] }
export interface ListOptions {
  domain?: string; allDomains?: boolean; status?: Status | "any";
  types?: NoteType[]; tags?: string[]; offset?: number; limit?: number;
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
  return view(argv);
}
export const list = (o: ListOptions) => run<ListPage>(listArgs(o));

export interface Note {
  id: string; domain: string; title: string; type: NoteType; status: Status; tags: string[];
  context?: string; files?: string[]; created?: string; updated?: string; review_by?: string;
  confirmed?: string[]; supersedes?: string[]; superseded_by?: string; origin?: string;
  revision: string; body: string; truncated: boolean;
}
/** LM's own default is 16,000 characters; Hivemind asks for the most it allows (64,000). */
export const read = (ref: string, opts: { domain?: string; maxChars?: number } = {}) =>
  run<Note>(view(["read", ref, "--max-chars", String(opts.maxChars ?? 64000), ...(opts.domain ? ["--domain", opts.domain] : [])]));

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
