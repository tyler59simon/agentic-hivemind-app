# Hivemind mock UX: handoff documents for Phases 2 to 5

Hivemind is being rebuilt to the UX of a set of ten mock screens. Phase 1 (theme, shell, pages over existing data, architecture canvas) is built and is the code you are reading. Phases 2 to 5 add the backends the mocks need. Each phase has one document here, written so that one session can implement that phase end to end without asking the user anything.

| Phase | Document | Mock screens | Depends on |
| --- | --- | --- | --- |
| 2 | [phase-2-interactive-sessions.md](phase-2-interactive-sessions.md) | 02 Start Agent Session, 03 Agent Workspace Chat | Phase 1 |
| 3 | [phase-3-changes.md](phase-3-changes.md) | 05 Changes List, 06 Change Detail | Phases 1 and 2 |
| 4 | [phase-4-review.md](phase-4-review.md) | 10 Agent Code Review | Phases 1, 2 and 3 |
| 5 | [phase-5-codex-and-terminal.md](phase-5-codex-and-terminal.md) | 04 Agent Workspace Codex Terminal | Phases 1 and 2 (4 for the "Review diff" link) |

**How to use these documents.** Read this file first, then your phase's document, then the spike findings it cites under [spikes/](spikes/). This file holds what every phase shares: the decisions already made, the map of the code after Phase 1, the conventions, how to run and verify, and the contracts between phases. Where a phase document and this file disagree about a shared name or shape, this file wins; tell the user about the conflict in your final report.

**If the code has moved.** These documents cite files by path plus an anchor string (text to search for), not by line number. If an anchor is gone, find its successor before you change anything, and say so in your report.

---

## 1. Decisions already made (do not reopen)

The user made these on 2026-11-10.

1. **Full parity with the mocks, in phases**, including backends that did not exist.
2. **Sections are pages; only notes are tabs.** The sidebar has six sections (Overview, Agent Workspace, Changes, Architecture, Memory, Review), each one page with a breadcrumb. Notes, and only notes, open as tabs and side by side in up to three panes, inside Memory. Do not add tabs or split panes for sessions, changes, diffs or anything else, with one exception already decided: Phase 5's terminal has its own tab strip.
3. **Brand:** the hex/wasp symbol and the word "Hivemind". The name or wordmark "Vesparc" appears nowhere in the product, the code or the documents' user-facing copy. The mock images carry that wordmark; ignore it.
4. **Dark only.** There is no light theme.
5. **A change (Phase 3)** is a `plan` note (the brief) plus an entry in a new Living Memory `changes` registry. Change numbers (CHG-014) are unique across the whole store.
6. **Approve (Phase 4)** commits the session's edits on the session's own worktree branch. It never merges and never pushes.
7. **The terminal (Phase 5)** is a real embedded terminal that runs the actual `claude` and `codex` terminal programs. Approvals inside it happen in the CLI's own prompts. This knowingly differs from mock 04, which draws Hivemind buttons inside the terminal.
8. **Order of work:** one phase per session, in order. Each phase ships a working app and is a separate branch and pull request.

## 2. What is not in scope for any phase

- Cloud sync, accounts, sharing.
- A light theme, a theme switch, a collapsible sidebar.
- Writing Living Memory's store files directly. Every change goes through Living Memory commands (section 5).
- Pushing branches, opening pull requests, or merging on the user's behalf, unless a phase document says a button does exactly that and the user clicks it.

---

## 3. The code after Phase 1

Stack: Tauri 2 (Rust) + React 19 + TypeScript 6 + Vite 8; Zustand 5 for client state; TanStack Query 5 for data; CodeMirror 6 for editing; `lucide-react` for icons; `@dagrejs/dagre` for the architecture layout. No router library and no component library.

### 3.1 Frontend map

| Path | What it is | Anchor to search for |
| --- | --- | --- |
| `src/main.tsx` | Entry. Renders `App`, or `QuickCapture` when the URL hash is `#capture` (one bundle, two windows). | `const isCapture` |
| `src/App.tsx` | Connect gate (settings card on failure), global shortcuts, live refresh from file-watcher events, window close guard. Renders `Shell`, `Palette`, `Toasts`. | `function useShortcuts()`, `function useLiveRefresh(` |
| `src/store.ts` | `useApp`: the route, the picked project, the Back stack, the palette. Persisted as `hivemind.nav`. Helpers `openProject`, `openSystem`, `openSession`. | `export type Route =` |
| `src/shell/Shell.tsx` | The frame and the page switch. | `const PAGES: Record<Page, () => ReactNode>` |
| `src/shell/Sidebar.tsx` | Brand, project picker, the six sections, user menu. | `export const SECTIONS` |
| `src/shell/Topbar.tsx` | Breadcrumb and the search field (Ctrl+K). | `function useCrumbs()` |
| `src/ui/Page.tsx` | Page building blocks: `PageHeader`, `Split` (main column + context rail), `Section`, `Tabs` (underline or pill), `ArrowLink`, `Row`, and the date helpers `longDate`, `dayMonth`. | `export function PageHeader` |
| `src/ui/Menu.tsx`, `src/ui/Modal.tsx`, `src/ui/toast.tsx` | Popover menu; `Modal` and `Confirm`; `toast()` and `Toasts`. | |
| `src/App.css` | The one stylesheet. Tokens in `:root`; sections marked with `/* ---- Name ---- */` comments. | `:root {` |
| `src/workspace/store.ts` | `useWorkspace`: the open notes (panes, tabs, unsaved flags, rail). `openNote` also navigates to Memory. | `export const useWorkspace` |
| `src/workspace/Workspace.tsx` | The note tab strip and panes; `OpenTabs` (the strip above the library). | `function PaneView(` |
| `src/workspace/RightSidebar.tsx` | `NoteRail`: Connections, Source history, On this page, Details, local graph. | `export function NoteRail()` |
| `src/lib/lm.ts` | Typed wrappers over Living Memory commands and their result types. Reads add `--actor viewer`. | `export async function run<T>` |
| `src/lib/agent.ts` | Agent session types and the `agent_*` invokes. | `export type AgentTask` |
| `src/lib/architecture.ts`, `src/lib/git.ts`, `src/lib/connection.ts` | Architecture folder reader; git activity; feature gates (`useProjectsEnabled`, `useSystemsEnabled`). | |
| `src/features/projects/OverviewPage.tsx` | Overview (mock 01). Project command center, or the store overview when no project is picked. | `function ProjectOverview(` |
| `src/features/projects/useProject.ts` | `useCurrentProject()` (the picked project), `useProject(slug)` (member notes, open work, due, charter), `useProjectOps`, `useGitActivity`. | `export function useCurrentProject()` |
| `src/features/projects/scope.ts` | `systemsForProject`: a system belongs to a project when they share a repository. | `export function systemsForProject` |
| `src/features/projects/briefing.ts` | `buildBriefing`: the Markdown context pack for an agent. | `export function buildBriefing` |
| `src/features/agents/AgentWorkspace.tsx` | Agent Workspace (mock 03, read-only): session list, `Transcript`, context rail. | `export function Transcript`, `function Session(` |
| `src/features/agents/events.ts` | Pure reducer from `SeqEvent`s to a transcript (`apply`, `build`, `merge`). Tested. | `export function apply(` |
| `src/features/changes/ChangesPage.tsx` | Changes over plan notes (no numbers, no stages yet). | `export function ChangesPage()` |
| `src/features/review/ReviewPage.tsx` | Review over notes due and agent-proposed registry updates. | `export function ReviewPage()` |
| `src/features/systems/ArchitecturePage.tsx` | Architecture: system picker, `AgentActions` ("Generate with agent"), canvas, inspector, sections. | `function SystemView(`, `function AgentActions(` |
| `src/features/systems/canvas.ts`, `ArchitectureCanvas.tsx` | The canvas: `canvasGraph`, `layoutGraph` (pure, tested) and the pan/zoom component. | `export function canvasGraph` |
| `src/features/systems/useSystem.ts` | `useSystem(slug)`, `useSystemProposals`, `useDiagram`. | `export function useSystemProposals` |
| `src/features/library/MemoryPage.tsx`, `library.ts` | Memory: library with search, type tabs and Status / Scope / Tag filters; sub-views Graph, Activity, Tags; hosts the note workspace. | `function Library()` |
| `src/features/editor/NoteTab.tsx` | The note page (mock 09): header, Reading / Source / History tabs. | `export function NoteTab` |
| `src/features/plans/PlanDialog.tsx` | The reviewed-plan dialog: make a Living Memory plan, show its diff, apply it. Use it for every plan-based write. | `export function PlanDialog` |

Routes today (`src/store.ts`):

```ts
export type Route =
  | { page: "overview"; view?: "work" }
  | { page: "agents"; session?: string }
  | { page: "changes"; ref?: string }
  | { page: "architecture"; system?: string }
  | { page: "memory"; view?: "notes" | "graph" | "activity" | "tags"; q?: string }
  | { page: "review" };
```

To add a page or sub-view: extend `Route`, add the component to `PAGES` in `src/shell/Shell.tsx`, add a breadcrumb leaf in `useCrumbs` in `src/shell/Topbar.tsx`, and a palette entry in `src/features/palette/Palette.tsx` (anchor `const page = (route: Route)`).

### 3.2 Backend map (`src-tauri/src`)

| File | What it is | Anchor |
| --- | --- | --- |
| `lib.rs` | Tauri commands, app state, event emission, `run()`. | `tauri::generate_handler![` |
| `bridge.rs` | One long-lived `living_memory.py serve --stdio` process; every Living Memory call goes through it. | `pub fn call(` |
| `watcher.rs` | File watcher; emits `notes-changed` and `store-changed`. | `store-changed` |
| `git.rs` | Read-only git and `gh` calls for a project's repositories. | `pub fn activity` |
| `architecture.rs` | Reads a system's Architecture Suite output folder. | `pub fn read_folder` |
| `settings.rs`, `drafts.rs`, `capture.rs` | Saved settings and environment overrides; note drafts; tray, hotkey, capture window. | |
| `agent/mod.rs` | Session manager: `Adapter` trait, `SessionInfo`, `Manager::start`, `cancel`, `pump`; `MAX_RUNNING`. | `pub trait Adapter`, `pub const MAX_RUNNING` |
| `agent/claude.rs` | The Claude Code adapter: command line, stdout line parsing, closing report. | `fn command(&self, spec: &Spec)` |
| `agent/scope.rs` | What a task may touch: `AgentTask`, `Policy`, `Spec`, `Scope`, allow rules. Built in Rust from the registry. | `pub enum AgentTask` |
| `agent/events.rs` | `Status`, `RunEvent`, `SeqEvent`, `Outcome`. | `pub enum RunEvent` |
| `agent/store.rs` | `index.json` plus one raw-line log per session under the app data folder. | `pub fn load_index` |

Commands registered today: `lm`, `connect`, `git_activity`, `system_architecture`, `system_diagram`, `system_diagram_source`, `get_settings`, `save_settings`, `capture_status`, `show_main`, `draft_put`, `draft_get`, `draft_delete`, `draft_list`, `agent_available`, `agent_start`, `agent_cancel`, `agent_sessions`, `agent_session`. Events emitted: `notes-changed`, `store-changed`, `agent-event`, `agent-sessions-changed`, `open-note`.

### 3.3 How an agent session works today

`agent_start(task, prompt)` resolves the task against Living Memory's registry in Rust (`agent/scope.rs`), spawns `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none ...`, writes one user message on stdin and closes it, then a pump thread reads stdout line by line. Every raw line is appended to the session's log; the adapter turns lines into `RunEvent`s, numbered from 0 as `SeqEvent`s and emitted as `agent-event`. When the process exits, Hivemind appends exactly one `Finished` event. Replaying a stored log yields the same numbered events as the live stream; the UI relies on that. Only one session may run at a time (`MAX_RUNNING`), and the only task kind is `system_passport`.

---

## 4. Conventions

- **Style:** one global stylesheet (`src/App.css`), plain class names, no CSS modules, no CSS-in-JS. Sizes in `rem` (the root font size scales with the window between 14px and 18px). Use the existing tokens; add a token only when a colour is used in more than one rule. Icons come from `lucide-react`, sized in `em`.
- **Structure:** a feature lives in `src/features/<name>/`. Pure logic goes in a `.ts` file with a `.test.ts` beside it; components stay thin. Shared building blocks live in `src/ui/`.
- **Minimum code.** No speculative options, no abstraction for a single use, no error handling for cases that cannot happen. Touch only what the phase needs; do not tidy neighbouring code. Remove only what your own change orphans.
- **Comments** say what something is for or why, in a sentence. Match the tone of the existing ones.
- **TypeScript:** `strict`, `noUnusedLocals` and `noUnusedParameters` are on, and `npm run build` runs `tsc` first, so an unused import fails the build.
- **Rust:** files are hand-formatted at about 140 columns and there is no `rustfmt.toml`. Do not run `cargo fmt` on the repository. `cargo clippy` must stay clean. On Windows, child processes are started with `CREATE_NO_WINDOW`, and a process tree is killed with `taskkill /T /F` (see `fn kill(` in `agent/mod.rs`).
- **Security rule for agents:** the folders a session may touch and the actions it may take are worked out in Rust from Living Memory's registry and the user's settings. The webview names things (a task kind, a project slug, a session id); it never supplies a path, a command line or a permission rule. Keep it that way in every new command.
- **Persisted data must stay readable.** `agent/store.rs` `load_index` returns an empty history if any entry fails to parse. Every field added to `SessionInfo` or to a stored record needs `#[serde(default)]` (and an `Option` or a `Default` type), plus a test that an index written before your change still loads.
- **Tests:** vitest runs in Node without a DOM, so tests cover logic, not rendering. Rust agent tests use a fake adapter and never start a real CLI. Bridge tests that need a real Living Memory run only when `HIVEMIND_TEST_LM_SCRIPT` is set.
- **Git:** branch from the previous phase's branch (Phase 2 from `feat/mock-ux`). Commit as you go; each commit builds and passes tests. Do not push, and do not open a pull request, unless the user asks. End commit messages with the attribution lines your session is configured to add.

## 5. Living Memory rules

Living Memory is a separate Python project (`agentic-living-memory`; the installed copy is at `%LOCALAPPDATA%\agentic-living-memory\app\living_memory.py` on Windows). It is the only writer of the store.

- Reads go through `view(...)` in `src/lib/lm.ts`, which adds `--actor viewer`.
- A note edit is `update` with `expected_revision` and only the changed fields. A stale revision (exit code 6) opens the three-way merge.
- Lifecycle and registry changes are **plans**: make the plan, show its diff with `inspect-plan`, apply it with `apply --expected-plan-sha256`. `PlanDialog` does all three. Never apply a plan the user has not seen, except where a phase document names a one-click action and says the plan is applied at once.
- Never open `search.sqlite3`, and never write a file under the store.
- **Never test against the user's real store.** Build a throwaway one (section 6).
- Changing Living Memory itself (Phase 3 only) is done in its source checkout, as its own branch and pull request there, then deployed with its `install.py --plan` and `--apply-plan`. The user applies install plans; ask before deploying.

## 6. Running and verifying

```sh
npm install
npm test                      # vitest
npx tsc --noEmit
npm run build                 # tsc && vite build
cd src-tauri && cargo test && cargo clippy
```

**A demo store.** `python scripts/seed_demo_store.py --out <scratch folder> [--architecture-example <suite>/examples/payments/aws]` builds a throwaway store with a "PayStream" project, about thirty notes of every type and state, two systems, a git repository with commits, and an architecture model. It prints the three variables to set: `HIVEMIND_LM_ROOT`, `HIVEMIND_LM_SCRIPT`, `HIVEMIND_PYTHON`.

**The running app, driven without touching the screen** (PowerShell):

```powershell
$env:HIVEMIND_LM_ROOT = "<scratch>\store"; $env:HIVEMIND_LM_SCRIPT = "<path>\living_memory.py"; $env:HIVEMIND_PYTHON = "<python.exe>"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$env:WEBVIEW2_USER_DATA_FOLDER = "<scratch>\webview-profile"   # keeps the real app's saved state untouched
npm run tauri dev
```

Then `python scripts/drive_ui.py --out <folder> nav:Memory wait:1 shot:memory` (needs a Python with Playwright) clicks through the app over the debugging port and saves page screenshots. Use it to compare each screen with its mock and to prove a flow works. The dev port 1420 is fixed, so only one dev instance can run.

Agent sessions, drafts and settings are stored in the app's real data folder even in a dev run. A phase that changes their format must test against copies, and must not leave test sessions behind.

**The mocks** are ten PNG screens (1487x1058) that the user keeps outside the repository, in a folder named `hivemind-mocks` beside this repository's folder. If they are there, look at the ones your phase names. Each phase document also describes its screens in words, so the work does not depend on the images.

## 7. Contracts between phases

These names and shapes are shared by more than one phase. A phase may add fields and commands of its own; it may not rename or reshape what is listed here.

### 7.1 Sessions (introduced by Phase 2; extended by Phases 3, 4, 5)

`AgentTask` (Rust `agent/scope.rs`, TypeScript `src/lib/agent.ts`; tagged by `kind`, snake_case):

```ts
type AgentTask =
  | { kind: "system_passport"; slug: string }                                           // exists today
  | { kind: "work"; project: string; repo: string; branch?: string; change?: number };  // Phase 2; `change` is filled from Phase 3 on
```

`project` is a project slug. `repo` must be one of that project's registered `repos` (compared after normalising slashes and case); Rust rejects anything else. `branch` is the branch to start from; when absent, the repository's current branch.

`SessionInfo` gains these fields (camelCase in JSON; every one has a serde default so older indexes load):

| Field | Type | Phase | Meaning |
| --- | --- | --- | --- |
| `mode` | `"unattended" \| "interactive"` | 2 | Unattended is today's one-prompt run. Default `unattended`. |
| `policy` | `"pre_approved" \| "ask" \| "accept_edits"` | 2 | How gated actions are decided. Default `pre_approved`. |
| `project` | `string \| null` | 2 | The project the session was started in. |
| `worktree` | `{ repo, path, branch, baseBranch, baseSha } \| null` | 2 | The git worktree an interactive work session runs in. |
| `turns` | `number` | 2 | Completed turns. |
| `filesChanged` | `{ files, added, removed } \| null` | 2 | The worktree's diff against `baseSha` after the last turn. |
| `review` | `{ state, commit, at } \| null` | 4 | `state` is `"pending" \| "approved" \| "changes_requested" \| "dismissed"`. |
| `sourceSha` | `string \| null` | 4 | For a passport session: the repository's HEAD when it succeeded. |
| `interface` | `"chat" \| "terminal"` | 5 | Default `chat`. |

`adapter` (exists today) is the engine: `"claude"` today, `"codex"` from Phase 5.

`Status` (Rust `agent/events.rs`, lowercase in JSON) becomes: `running` (a turn is in progress), `waiting` (a permission prompt awaits the user), `idle` (the last turn finished and the session can take another message, whether or not its process is still alive), and the end states `succeeded`, `failed`, `cancelled`, `ended` (the user ended an interactive session). Unattended sessions never use `waiting`, `idle` or `ended`.

`RunEvent` gains (tagged by `type`, camelCase): `userMessage { text }`, `approvalRequest { requestId, tool, summary, input, canAlways }`, `approvalResolved { requestId, decision }` with `decision` one of `"allow" | "allow_always" | "deny" | "withdrawn"`, `turnFinished { ok, reason, costUsd, durationMs, result, denials }`, and `filesChanged { files: [{ path, status, added, removed }] }`. `Finished` stays the single last event of a session.

Commands added by Phase 2: `agent_send(sessionId, text)`, `agent_answer(sessionId, requestId, decision)`, `agent_interrupt(sessionId)`, `agent_end(sessionId)`, `agent_files(sessionId)`. `agent_start` takes the task, the prompt and an options object (`{ policy, context }`, where `context` is a list of note refs to include in the briefing). `agent_cancel` keeps its meaning: kill the process now.

Worktrees live under the app data folder, in `worktrees/<repo folder name>-<8 hex of a hash of the repo path>/<first 8 of the session id>`, on a branch named `hivemind/<first 8 of the session id>` created from the start branch. Rust module: `src-tauri/src/worktree.rs`.

Frontend additions other phases build on: the route `{ page: "agents"; session?: string; view?: "new" }`; a session-draft store `src/features/agents/draft.ts` exporting `useSessionDraft` with `task`, `context: string[]` (note refs), `change: number | null`, and `addContext(ref)`, `removeContext(ref)`, `reset()`; the buttons "Use in agent session" (note page) and "Add to agent context" (library preview) call `addContext`.

### 7.2 Changes (introduced by Phase 3)

Living Memory registry file `changes.json` at the store root: `{"changes": [...], "version": 1}`, entries sorted by `id`. Entry fields: `id` (integer, store-wide), `title`, `project` (slug), `brief` (`domain:id` of a `plan` note), `stage` (`explore | design | implement | validate`), `status` (`active | done | cancelled`), `repo`, `branch`, `system`, `element` (each a string or null), `created`, `updated`.

Commands: `changes [--status active|done|cancelled|any] [--project SLUG]` returns `{ ok, changes, warnings }`, each row being the entry plus the derived `display` (`"CHG-014"`), `brief_status` and `actions: { open, done }`. `change-plan create|update|close` builds a plan from a JSON payload; journal kinds are `change_create`, `change_update`, `change_close`.

App: `Change` type, `changes()` and `changePlan()` in `src/lib/lm.ts`; the gate `useChangesEnabled` (`commands.includes("changes")`) in `src/lib/connection.ts`; the route becomes `{ page: "changes"; id?: number; view?: "detail" }`. When the connected Living Memory has no `changes` command, the Phase 1 page over plan notes stays as the fallback.

A session belongs to a change through `task.change`. A change's sessions are the sessions whose task carries its id.

### 7.3 Review (introduced by Phase 4)

Commands: `review_files(sessionId)` (the changed files with added and removed counts), `review_file(sessionId, path)` (`{ base, head, binary }`, text contents or null), `review_approve(sessionId, message)` (commits on the worktree branch; returns the commit hash), `review_request_changes(sessionId, text)` (sends a follow-up message to the session, resuming it if needed), `review_dismiss(sessionId)`, `review_discard(sessionId)` (resets the worktree to `baseSha`; destructive, behind a confirmation). `SessionInfo.review` records the outcome.

A session is "waiting for review" when it has `filesChanged.files > 0`, is not running, and `review` is null or `pending`. Phases 3 and 5 show that state with the yellow chip (`status-chip waiting`).

### 7.4 Terminal (introduced by Phase 5)

Rust module `src-tauri/src/term/`; commands `term_open`, `term_write`, `term_resize`, `term_close`, `term_list`; output reaches the webview over a Tauri `Channel`. Frontend `src/features/terminal/`. A terminal belongs to a session (`SessionInfo.interface = "terminal"`) and runs in that session's worktree.

## 8. Things every phase must report at the end

- What was built, what was verified in the running app, and what was not.
- Anything in the document that turned out wrong, and what you did instead.
- Every side effect outside the repository (a worktree left behind, a Living Memory install, a daemon started, a config file a CLI changed).
- What you recorded in Living Memory (the project's memory system), if your session has it: decisions and gotchas a later session would otherwise rediscover.
