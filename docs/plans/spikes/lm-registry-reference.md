# Living Memory registry reference: how `systems` and `projects` are built, for adding a `changes` registry

Repo: `%USERPROFILE%\Documents\Sandbox\agentic-living-memory` (branch `main`, clean, HEAD `9ac6ea2`, in sync with `origin/main`).
All `path:line` citations are relative to that repo at HEAD `9ac6ea2`. Line numbers come from a full read of each cited file.

## How this was produced

- **Read fully:** `core/systems.py`, `core/projects.py`, `core/governance.py`, `core/repository.py`, `core/notes.py`, `core/note_format.py`, `core/note_types.py`, `core/tag_taxonomy.py`, `core/common.py`, `core/storage.py`, `core/backup.py`, `core/migration.py`, `core/instructions.py`, `core/init_domain.py`, `core/cli.py` (all 880 lines), `install.py`, `living_memory.py`, `tests/test_systems.py`, `tests/test_projects.py`, `tests/test_project_attribution.py`, `tests/test_app_bridge.py`, `tests/test_core.py`, `tests/test_links.py`, `SCRIPT_REFERENCE.md`, `PROTOCOL.md`, `README.md`, `AGENTS.md`, `INSTALLATION.md`, `INTEGRATION.md`, `VALIDATION.md`, `ARCHITECTURE.md`, `TAGGING.md`, `RECOVERY.md`, `MAINTENANCE.md`, and the complete diff of commit `9ac6ea2` (PR #26).
- **Sampled:** `core/runtime.py` (lines 1-230 and 1035-1094 only), `core/session_start.py` (55-135), `core/sync.py` (100-135 plus greps), `core/installer_lifecycle.py` (1-130, 200-236), `NOTE_TYPES.md` (from line 25), `tests/test_open_work.py` (1-62), `tests/test_note_format.py` (1-60), `scripts/installed_smoke.py`, `tests/scenarios/lifecycle.json`, and the diff of commit `c221bb3` (PR #21) for seven shared files.
- **Not read:** `core/search.py`, `core/semantic.py`, `core/maps.py`, `core/recall.py`, `core/usage.py`, `core/logs.py` (function list only), `core/wiring.py`, `integrations/setup.py` (function list only), `scripts/simulate.py`, `OBSIDIAN.md`, the other test files (test names listed for six of them).
- **Not executed:** no Living Memory command was run apart from the one `read` of the codebase map, and the test suite was not run (it would write `__pycache__` under `Documents`). **Every JSON example below is derived from the code, not captured from a run.** Values such as IDs, hashes and timestamps are illustrative.
- **Environment facts checked read-only:** the configured store root is `%USERPROFILE%\LivingMemory` (from `~/.config/agentic-living-memory/config.json`). Its top level currently holds `bindings.json`, `schema-version.json`, `tag_taxonomy.json` and no `projects.json` or `systems.json`, so no registry entry exists in the live store yet. The installed copy at `%LOCALAPPDATA%\agentic-living-memory\app` already contains `core\systems.py`.

---

## 1. The systems registry module

File: `core/systems.py` (120 lines, no BOM, CRLF in the working tree, dense one-line style, longest line 239 characters).

### 1.1 Imports and constants

```python
# core/systems.py:5-14
from __future__ import annotations
import uuid
from pathlib import Path
from .common import canonical_domain
from .projects import SLUG,_charter_domain,_repos,_text,infer_tags
from .repository import read_json,canonical_json,find_secrets,store_lock,now

STATUSES=('active','deprecated','retired')
SHARED={'slug','name','description','owners','capabilities','repos','depends_on','architecture','passport'}
FIELDS={'create':SHARED,'update':SHARED|{'status'},'retire':{'slug'}}
```

`FIELDS` is both the list of valid actions and the allow-list of payload keys per action.

### 1.2 Functions (complete list)

```python
def tag(slug)                                   # systems.py:16
def _path(root)                                 # systems.py:17
def load(root)                                  # systems.py:19-24
def infer(item,domain,root,touched=(),cwd=None) # systems.py:26-30
def _strings(value,field,most,high)             # systems.py:32-34
def _clean(values,base,others)                  # systems.py:36-63
def _registry(entries)                          # systems.py:65
def system_plan(root,action,payload)            # systems.py:67-102
def listing(root,status='any')                  # systems.py:104-120
```

There are no classes.

- **`tag(slug)`** returns `f'system/{slug}'`.
- **`_path(root)`** returns `Path(root)/'systems.json'`.
- **`load(root)`** reads the file with `read_json(_path(root),{'version':1,'systems':[]})`, so a missing file is an empty registry. It raises `ValueError('Invalid or unreadable configuration preserved: <path>')` unless the value is a dict whose `systems` is a list of dicts that each have a string `slug`. The `version` field is written but never checked.
- **`infer(...)`** returns `(tags to add, candidate slugs)` for a capture. It loads the registry, returns `([],[])` on a broken registry, and delegates to `projects.infer_tags(item,domain,root,registry,'system',touched,cwd)`.
- **`_strings(value,field,most,high)`** validates a list of at most `most` strings, each trimmed and 1..`high` characters (through `projects._text`), and removes duplicates keeping order.
- **`_clean(values,base,others)`** layers validated payload values over `base` (an entry dict) and returns the new entry. `others` is the list of the other systems' slugs, used to validate `depends_on`. Only keys present in `values` are touched. It ends with a credential scan.
- **`_registry(entries)`** returns the file text: `canonical_json({'version':1,'systems':sorted(entries,key=lambda s:s['slug'])})`.
- **`system_plan(root,action,payload)`** validates the payload and builds a governed plan. Kinds are `system_create`, `system_update`, `system_retire`. It writes nothing except the plan file. Section 3 traces it line by line.
- **`listing(root,status='any')`** returns `{'ok':True,'systems':rows,'warnings':warnings}`. Section 4 gives the shape.

### 1.3 On-disk file

- **Name and location:** `<store root>/systems.json`, beside `bindings.json` and `tag_taxonomy.json`.
- **Absent until first use.** It is created by the first applied `system_create` plan, and an undo of that plan deletes it again (`tests/test_systems.py:76`).
- **Encoding:** `canonical_json` (`core/repository.py:123-124`): `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. Keys are sorted, there is no whitespace and no trailing newline. It is written through `atomic_write` as UTF-8 with `\n` newlines.
- **Entry order:** sorted by `slug` on every write.

Realistic example (pretty-printed here; the real file is one line):

```json
{
  "systems": [
    {
      "architecture": "C:/work/architecture/billing",
      "capabilities": ["Take payments", "Issue invoices"],
      "created": "2026-11-10T10:48:16.123456+00:00",
      "depends_on": ["ledger"],
      "description": "Takes payments.",
      "name": "Billing",
      "owners": ["Payments team"],
      "passport": "demo:6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
      "repos": ["C:/work/project/billing"],
      "slug": "billing",
      "status": "active",
      "updated": "2026-11-10T10:48:16.123456+00:00"
    }
  ],
  "version": 1
}
```

### 1.4 Fields

| Field | Type | Default at create | Limits and normalisation | Source |
| --- | --- | --- | --- | --- |
| `slug` | string | required | must fully match `[a-z0-9][a-z0-9-]{0,39}`; identity; cannot be changed | `projects.py:11`, `systems.py:75-76` |
| `name` | string | required at create | trimmed, 1..80 characters | `systems.py:39`, `:82` |
| `description` | string | `''` | trimmed, 0..500 characters; `null` becomes `''` | `systems.py:40` |
| `status` | string | `'active'` | one of `STATUSES`; **not accepted in a create payload** | `systems.py:41-43`, `:14` |
| `owners` | list of strings | `[]` | at most 10, each 1..80, de-duplicated | `systems.py:44` |
| `capabilities` | list of strings | `[]` | at most 20, each 1..120, de-duplicated | `systems.py:45` |
| `repos` | list of strings | `[]` | at most 10 absolute paths; backslashes become `/`; trailing `/` stripped; de-duplicated; may be empty | `systems.py:46`, `projects.py:67-72` |
| `depends_on` | list of slugs | `[]` | each must be another registered system; no self-reference; de-duplicated | `systems.py:47-53` |
| `architecture` | string or null | `None` | absolute folder path, normalised like a repo; `null` clears it | `systems.py:54-57` |
| `passport` | string or null | set by create | at create: an object `{domain?, title?, body}` describing the note to write; the entry stores the resulting ref `domain:uuid`. At update: a note ref string or `null`, type-checked only | `systems.py:58-60`, `:83-96` |
| `created` | string | `now()` | UTC ISO 8601 with microseconds, e.g. `2026-11-10T10:48:16.123456+00:00` (`repository.py:115-116`) | `systems.py:86` |
| `updated` | string | `now()` | rewritten by every update and retire | `systems.py:101` |

A credential scan runs over `name`, `description`, `owners` and `capabilities` (`systems.py:61-62`, `find_secrets` at `repository.py:84-104`).

### 1.5 Slug rules

```python
SLUG=re.compile(r'[a-z0-9][a-z0-9-]{0,39}')   # core/projects.py:11, imported by systems
```

`system_plan` checks `isinstance(slug,str) and SLUG.fullmatch(slug)` (`systems.py:75-76`). The slug is 1 to 40 characters, lowercase letters, digits and hyphens, and cannot start with a hyphen. Uniqueness is per registry: nothing stops a project and a system from sharing a slug. There is no rename: `update` finds the entry by `slug`, and `name` is the only display label.

### 1.6 Status values and transitions

- `STATUSES=('active','deprecated','retired')` (`systems.py:12`).
- Create always writes `active`. A create payload with `status` fails with `Unknown payload fields: status` (`tests/test_systems.py:91`).
- `update` may set any of the three values. **No transition rule is enforced**: `retired` can go back to `active`.
- `retire` is exactly `update` with `{'status':'retired'}` (`systems.py:100`). It does not check for dependents and does not refuse an already retired system.
- Only `active` entries take part in auto-attribution (`projects.py:56`, `tests/test_systems.py:143-145`).
- Retiring touches only `systems.json`. The tag stays in the taxonomy and on notes (`tests/test_systems.py:97-104`).

### 1.7 How the `system/<slug>` tag enters and stays in the taxonomy

1. `'system'` is a member of `FACETS` (`core/repository.py:18`), so tags of that facet pass the facet check.
2. `system_plan` create adds the tag to `tag_taxonomy.json` **in the same plan** when it is not already there:

   ```python
   # core/systems.py:89, 93-94
   known=read_json(root/'tag_taxonomy.json',{'tags':[]});known=known.get('tags',[]) if isinstance(known,dict) else known
   changes={};added=tag(slug) not in known
   if added:changes['tag_taxonomy.json']=content([tag(slug)],root,allow_managed=True)[0]
   ```

   `tag_taxonomy.content` (`core/tag_taxonomy.py:13-25`) returns the new file text `{"facets":[...FACETS...],"tags":[...sorted...],"version":2}`.
3. The passport note is validated with `extra_tags=[tag(slug)]` (`systems.py:95`), because the tag is not on disk yet when the plan is built (`repository.py:424-425`).
4. `taxonomy-plan` refuses the facet: `Create systems with system-plan; system/* tags are not added by taxonomy-plan` (`tag_taxonomy.py:21`).
5. Nothing ever removes the tag except an undo of the create (guarded, section 7) or a `retag-plan` that maps it away.

### 1.8 Error messages raised by `core/systems.py`

All are `ValueError`. The CLI turns each into `{"ok":false,"error":{"code":"invalid","message":...}}` with exit code 2 (section 5.4), because none of these messages has "stale" or "conflict" before its first `: ` or quote.

| Message | Line |
| --- | --- |
| `Invalid or unreadable configuration preserved: <path>` | `systems.py:23` |
| `<field> must be a list of at most <most> strings` | `systems.py:33` |
| `<field> must be <low>..<high> characters` (from `projects._text`) | `projects.py:64` |
| `status must be one of active, deprecated, retired` | `systems.py:42` |
| `repos must be a list of at most 10 absolute folder paths` / `repos must be absolute paths` | `projects.py:69-70` |
| `depends_on must be a list of system slugs` | `systems.py:49` |
| `A system cannot depend on itself` | `systems.py:50` |
| `depends_on names unknown systems: a, b; create them with system-plan first` | `systems.py:52` |
| `architecture must be an absolute folder path or null` | `systems.py:56` |
| `passport must be a note reference or null` | `systems.py:59` |
| `Potential credential detected (<kind>) in the system fields; remove it` | `systems.py:62` |
| `system-plan action must be create, update or retire` | `systems.py:71` |
| `Payload must be a JSON object` | `systems.py:72` |
| `Unknown payload fields: a, b` | `systems.py:74` |
| `slug must match [a-z0-9][a-z0-9-]{0,39}` | `systems.py:76` |
| `System <slug> already exists` | `systems.py:81` |
| `create requires name` | `systems.py:82` |
| `create requires passport.body (with an Executive Summary)` | `systems.py:84` |
| `passport accepts domain, title and body` | `systems.py:85` |
| `passport.domain <name> is not a bound domain` (from `_charter_domain`) | `projects.py:137` |
| `passport.title must be a string` | `systems.py:92` |
| `Unknown system <slug>` | `systems.py:99` |

Errors from `build_note` also surface at create, for example `Note needs an Executive Summary: start the body with a short summary, or pass --summary` (`note_format.py:156`) and `Unknown tags require an approved taxonomy plan: concern/architecture` (`repository.py:433`) when the store's taxonomy lacks a tag the passport hardcodes.

---

## 2. The projects registry, and a comparison

File: `core/projects.py` (155 lines). It is the older registry (PR #21, commit `c221bb3`) and the home of the helpers that systems reuses.

### 2.1 Constants and functions

```python
STATUSES=('active','paused','archived')                    # projects.py:10
SLUG=re.compile(r'[a-z0-9][a-z0-9-]{0,39}')                 # projects.py:11
FIELDS={'create':{'slug','name','repos','description','aliases','charter'},
        'update':{'slug','name','repos','aliases','description','status','charter'},
        'archive':{'slug'}}                                 # projects.py:12
MAX_AUTO=2                                                  # projects.py:37

def tag(slug)                                               # :14  -> f'project/{slug}'
def _path(root)                                             # :15  -> Path(root)/'projects.json'
def load(root)                                              # :17-22
def _norm(path)                                             # :24
def match_path(path,projects)                               # :26-35
def resolve_file(value,domain,root)                         # :39-42
def infer(item,domain,root,touched=(),cwd=None)             # :44-48
def infer_tags(item,domain,root,entries,facet,touched=(),cwd=None)   # :50-61  (shared)
def _text(value,field,low,high)                             # :63-65  (shared)
def _repos(repos)                                           # :67-72  (shared)
def _clean(values,base)                                     # :74-92
def _registry(entries)                                      # :94
def project_plan(root,action,payload)                       # :96-131
def _charter_domain(root,named,repos,field='charter.domain')# :133-140 (shared)
def listing(root,status='any')                              # :142-155
```

### 2.2 File and entry

`<store root>/projects.json`, written as `canonical_json({'version':1,'projects':[...sorted by slug...]})`.

```json
{
  "projects": [
    {
      "aliases": ["HM"],
      "charter": "demo:0d9a7c11-2f3e-4a5b-9c6d-7e8f9a0b1c2d",
      "created": "2026-11-09T13:00:59.054584+00:00",
      "description": "A demo.",
      "name": "Hivemind",
      "repos": ["C:/work/project/hive"],
      "slug": "hivemind",
      "status": "active",
      "updated": "2026-11-09T13:00:59.054584+00:00"
    }
  ],
  "version": 1
}
```

Field rules (`projects.py:74-92`): `name` 1..80; `description` 0..500; `repos` required at create, at most 10 absolute paths; `aliases` at most 5 strings of 1..40; `status` one of `STATUSES`; `charter` a ref string or `null` on update. The credential scan covers `name`, `description` and `aliases`.

### 2.3 Charter note, status and archiving

- **Charter:** `project-plan create` requires `charter: {domain?, title?, body}` (`projects.py:112-114`). It builds a `context` note with a pre-generated UUID, tags `['subject/project','concern/knowledge','project/<slug>']`, default title `"<name> charter"`, and stores `entry['charter']=f'{domain}:{note_id}'` (`projects.py:119-125`).
- **Charter domain** (`_charter_domain`, `projects.py:133-140`): the named domain if it is bound, has a folder, or is the global domain; else the domain bound to `repos[0]`; else the global domain (`_global`).
- **Status:** `active`, `paused`, `archived`. `update` sets any value; `archive` is `update` with `{'status':'archived'}` (`projects.py:129`). Nothing else changes: the charter note, the tag and tagged notes are left alone (`tests/test_projects.py:85-93`).
- **SessionStart** uses the registry: `Project: NAME (project/SLUG; capture with --project SLUG) — charter summary · charter REF`, or `Projects here: ...` (`core/session_start.py:61-100`). When the stored charter ref does not resolve, it falls back to the newest active `context` note carrying the project tag (`session_start.py:71-80`). **Systems has no SessionStart integration.**

### 2.4 Attributing notes to a project

Membership is the `project/<slug>` tag on a note. Nothing else records it.

- **Explicit:** `capture --project SLUG` (`CAPTURE_FACETS`, `core/cli.py:68`, parser at `cli.py:361`). An unregistered slug fails in `repository.validate` with `Unknown tags require an approved taxonomy plan: project/<slug>`.
- **Automatic, on capture only** (`cli.py:501-509`, `projects.infer_tags` at `projects.py:50-61`). A note with no tag of the facet gets one from the first level that matches: (1) the note's `files`, (2) with `--session`, the turn's touched files, (3) with `--session`, the cwd. Only `active` entries whose tag is in the taxonomy count; the longest repo prefix wins per file; one or two matches are tagged and reported in `inferred_tags`; more than `MAX_AUTO` (2) add nothing and return `project_candidates` (systems: `system_candidates`).
- **After the fact:** `update REF --tag ...` replaces the whole tag set (`cli.py:609-610`); `update` has no `--project` flag (`tests/test_projects.py:100`). `plan retag REF` and bulk `retag-plan` also work. A tag-only update does not bump `updated` (`notes.py:497`).
- **Reading membership:** `list --tag project/x [--all-domains] [--with-summary]`, `open --tag`, `review --tag` (`cli.py:371-372`, `:411`).
- **There is no triage or suggest command for projects.** The only `--suggest` in the CLI is `promote-plan --suggest` (`cli.py:408`), which proposes moves to the global domain. Triage is expected to be done by a client with `list` plus `update --tag --expected-revision`.

### 2.5 Systems versus projects

```diff
  Shared, lives in core/projects.py, imported by systems.py:9
    SLUG, _text, _repos, _charter_domain(root,named,repos,field), infer_tags(...,facet,...)

  Copied line for line (same shape, different nouns)
    tag(), _path(), load(), infer(), _registry(), listing() skeleton,
    the whole create/update/terminal-action flow of *_plan()

- projects: STATUSES active | paused | archived        terminal action "archive"
+ systems:  STATUSES active | deprecated | retired     terminal action "retire"

- projects: extra fields aliases (<=5 x 1..40)
+ systems:  extra fields owners, capabilities, depends_on, architecture

- projects: create requires name AND repos
+ systems:  create requires name only (repos may be [])

- projects: note field "charter", tags subject/project + concern/knowledge, title "<name> charter"
+ systems:  note field "passport", tags subject/project + concern/architecture, title "<name> passport"

- projects: _clean(values,base)
+ systems:  _clean(values,base,others)     # others = other slugs, for depends_on

- projects: listing rows add tag, tag_registered
+ systems:  listing rows add tag, tag_registered, dependents; extra warnings for architecture and depends_on

- projects: FIELDS written out per action
+ systems:  FIELDS built from a SHARED set

- projects: SessionStart "Project:" line, SERVE_API bumped 1 -> 2 in the same PR
+ systems:  no SessionStart integration, no SERVE_API bump
```

PR #26 also refactored projects so the helpers could be shared: `infer` was split into `infer` plus the generic `infer_tags`, the repo validation moved out of `_clean` into `_repos`, `_charter_domain` gained a `field` parameter for its error message, and `allow_project` was renamed `allow_managed` in `core/tag_taxonomy.py`.

---

## 3. Plan, inspect, apply for registry changes

### 3.1 Subcommands and flags

```text
system-plan  create|update|retire   [--payload-file FILE]     # cli.py:403
project-plan create|update|archive  [--payload-file FILE]     # cli.py:401
inspect-plan PLAN_ID                                           # cli.py:384
apply        PLAN_ID --expected-plan-sha256 DIGEST   (required) # cli.py:383
undo         OPERATION_ID                                      # cli.py:387
history      [--note ID] [--limit 20]                          # cli.py:386
diff         OPERATION_ID                                      # cli.py:389
recover      OPERATION_ID [--direction forward|backward] [--abandon]   # cli.py:388
```

The action is positional, there are no per-field flags, and the whole request is one JSON object. Without `--payload-file` the payload is read from stdin. Every subcommand also accepts `--root`, `--domain`, `--cwd`, `--json`, `--actor` before or after the subcommand name (`cli.py:351-357`).

Payloads:

```json
{"slug":"billing","name":"Billing","description":"Takes payments.","owners":["Payments team"],
 "capabilities":["Take payments"],"repos":["C:/work/project/billing"],"depends_on":["ledger"],
 "architecture":"C:/work/architecture/billing",
 "passport":{"domain":"demo","title":"Billing passport","body":"## Executive Summary\nBilling takes payments."}}
```

```json
{"slug":"billing","name":"Billing v2","status":"deprecated","owners":["Platform"],"architecture":null}
```

```json
{"slug":"billing"}
```

### 3.2 Plan file

- **Location:** `<store root>/.plans/<plan_id>.json` (`governance.py:21`). Plan IDs are `uuid.uuid4().hex` (32 lowercase hex characters).
- **Lifetime:** nothing in `core/` deletes a store plan file. There is no command that lists plans, so a client must keep the `plan_id`. `inspect-plan` returns the digest again.
- **Format** (`governance.py:17-20`), canonical JSON:

```json
{
  "changes": {
    "domains/demo/notes/CONTEXT - billing-passport-6f0c1d2e.md": "---\ntitle: \"Billing passport\"\n...full file text...",
    "systems.json": "{\"systems\":[{...}],\"version\":1}",
    "tag_taxonomy.json": "{\"facets\":[\"subject\",\"concern\",\"platform\",\"technology\",\"project\",\"system\"],\"tags\":[...],\"version\":2}"
  },
  "created": "2026-11-10T10:48:16.100000+00:00",
  "digest": "<sha256 of canonical_json of this object without the digest key>",
  "domains": ["demo"],
  "expected": {
    "domains/demo/notes/CONTEXT - billing-passport-6f0c1d2e.md": null,
    "systems.json": null,
    "tag_taxonomy.json": "<sha256 of the taxonomy file bytes when the plan was made>"
  },
  "id": "<32 hex>",
  "kind": "system_create",
  "schema": 2,
  "summary": {"slug":"billing","tag":"system/billing","added_tag":true,"passport":"demo:6f0c1d2e-...","files":3}
}
```

`changes` maps a store-relative POSIX path to the complete new file text, or `null` to delete the file. `expected` maps the same paths to the SHA-256 of the current bytes, or `null` when the file must not exist. An optional `guards` object holds `absent_ids` and `unused_tags` (`governance.py:8-10`, `:19`).

### 3.3 Results

`system-plan` prints (key order as produced, `governance.py:22` plus `cli.py:792`):

```json
{"ok":true,"plan_id":"<32 hex>","digest":"<64 hex>","kind":"system_create",
 "summary":{"slug":"billing","tag":"system/billing","added_tag":true,"passport":"demo:6f0c1d2e-...","files":3},
 "hint":"Review with inspect-plan PLAN_ID, then apply PLAN_ID --expected-plan-sha256 DIGEST."}
```

For `update` and `retire` the summary is `{"slug":"billing","fields":["architecture","name","owners","status"],"files":1}` (`systems.py:102`); `fields` is the sorted list of payload keys other than `slug`, or `["status"]` for retire.

`inspect-plan` prints (`governance.py:71-81`):

```json
{"ok":true,"plan_id":"<32 hex>","digest":"<64 hex>","kind":"system_create","summary":{...},
 "effects":[
   {"path":"domains/demo/notes/CONTEXT - billing-passport-6f0c1d2e.md","expected_revision":null,"action":"write","diff":"--- ...\n+++ ...\n@@ ...","truncated":false},
   {"path":"systems.json","expected_revision":null,"action":"write","diff":"...","truncated":false},
   {"path":"tag_taxonomy.json","expected_revision":"<64 hex>","action":"write","diff":"...","truncated":false}
 ]}
```

`effects` follow the plan file's key order, which is alphabetical by path. `diff` is a unified diff of the current file against the planned text, capped at 16,000 characters. Because it is computed against the file as it is now, inspecting a plan after it was applied shows empty diffs; use `diff OPERATION_ID` for the true before and after.

`apply` prints the transaction receipt (`repository.py:676`):

```json
{"ok":true,"operation_id":"<the plan id>","state":"committed","idempotent":false}
```

A `warnings` list is added when a domain's derived state could not be rebuilt (`governance.py:35-40`). Applying the same plan again returns `"idempotent":true` and changes nothing (`repository.py:506-513`, `:644-648`).

### 3.4 How apply detects stale plans and concurrent edits

In order, inside `governance.apply` (`governance.py:24-41`), all under the store lock:

1. `plan_id` must match `[a-f0-9]{32}`, else `Invalid plan identity`.
2. The plan file must exist, else `Plan unavailable`.
3. The digest is recomputed over the plan without its `digest` key. It must equal both the stored digest and `--expected-plan-sha256`, else `Plan digest mismatch` (exit 2).
4. `_check_guards` re-checks `absent_ids` and `unused_tags`, raising `stale plan: ...` (exit 6).
5. `repository.transaction(root, changes, kind, expected, plan_id)` compares every touched file's current SHA-256 with `expected` and raises `Stale revision: <path>` (exit 6) on any difference (`repository.py:516-520`).

Consequences for a registry:

- The check is **per whole file**. Two outstanding plans against `systems.json` cannot both apply: the second fails with `Stale revision: systems.json` and must be planned again, even if the two plans concern different systems.
- A create also carries `tag_taxonomy.json`, so any taxonomy change between plan and apply makes it stale.
- A create's note path has `expected: null`, so a file appearing at that path makes it stale.
- Plans do not expire. An old plan applies as long as its files are unchanged.

### 3.5 How the write is journaled

`repository.transaction` (`repository.py:494-534`):

1. Folds case-only renames, then finishes any operation left pending by a crashed process (`roll_forward_pending`).
2. Builds one effect per changed file, in path order.
3. Writes `<root>/.operations/<operation_id>/journal.json` with state `prepared`, then a `pending` marker file beside it.
4. Calls `recover(root, operation_id, 'forward')` (`repository.py:633-676`), which validates every effect, sets state `applying`, writes new files before deleting old ones through `atomic_write`, sets state `committed`, adds `completed`, and removes the marker.

For an applied plan the operation ID **is the plan ID** (`governance.py:34`). Section 7 gives the journal schema.

After the transaction, `apply` runs `reconcile(domain, root)` for each domain in the plan's `domains` (`governance.py:35-36`): it rewrites `INDEX.md` and `ARCHIVE.md`, rebuilds the search index, and refreshes a managed Obsidian overlay (`repository.py:679-696`). A create passes `[passport domain]`; update and retire pass `[]`, so nothing is rebuilt.

### 3.6 How undo reverses it

`undo OPERATION_ID` (`governance.py:121-144`) does not write. It builds a new plan of kind `undo:<operation_id>` whose `changes` restore each effect's `before` content (`null` deletes a file the operation created). That plan is applied with `apply` like any other, and its own journal makes the undo undoable. Section 7.4 lists the guards.

For a `system_create` the undo plan deletes the passport note, restores the previous `tag_taxonomy.json`, and deletes `systems.json` if the create had made it (`tests/test_systems.py:73-79`).

### 3.7 Worked trace: `system-plan create`

**Step 1, argv.** The payload goes on stdin.

```powershell
'{"slug":"billing","name":"Billing","repos":["C:/work/project/billing"],"passport":{"body":"## Executive Summary\nBilling takes payments."}}' |
  & py -3.15 living_memory.py --root C:\tmp\lm-dev system-plan create
```

**Step 2, entry point.** `living_memory.py:3-5` calls `core.cli.main()`.

**Step 3, parser.**

```python
# core/cli.py:351-357
def common(p,suppress=False):
    default=argparse.SUPPRESS if suppress else None
    p.add_argument('--root',type=Path,default=default);p.add_argument('--domain',default=default);p.add_argument('--cwd',default=default)
    p.add_argument('--json',action='store_true',default=argparse.SUPPRESS if suppress else False)
    p.add_argument('--actor',choices=['main','subagent','viewer'],default=argparse.SUPPRESS if suppress else os.environ.get('LIVING_MEMORY_ACTOR','main'))
common(parser);subs=parser.add_subparsers(dest='command',required=True)
def sub(name):p=subs.add_parser(name);common(p,True);return p
# core/cli.py:403
p=sub('system-plan');p.add_argument('action',choices=['create','update','retire']);p.add_argument('--payload-file',type=Path)
```

**Step 4, common preamble** (`cli.py:420-451`): resolve the store root (`resolve_root(args.root)`), point the operational log at it, resolve the domain from `--domain`, the session pin or the cwd binding, then apply the actor gates:

```python
# core/cli.py:450-451
if args.actor=='subagent' and cmd not in READ_ONLY:raise ValueError('Subagents are read-only; return mutation proposals to the main agent')
if args.actor=='viewer' and cmd not in VIEWER:raise ValueError('Viewers are read-only; run changes as --actor main')
```

**Step 5, handler.**

```python
# core/cli.py:789-792
elif cmd=='system-plan':
    from .systems import system_plan
    result=system_plan(root,args.action,_payload(args))
    result['hint']='Review with inspect-plan PLAN_ID, then apply PLAN_ID --expected-plan-sha256 DIGEST.'
# core/cli.py:9-13
def _payload(args):
    if getattr(args,'payload_file',None):raw=args.payload_file.read_text(encoding='utf-8')
    else:raw=sys.stdin.read()
    if len(raw.encode())>1024*1024:raise ValueError('Payload exceeds 1 MiB')
    return json.loads(raw)
```

**Step 6, plan builder.** The whole of `system_plan`:

```python
# core/systems.py:67-102
def system_plan(root,action,payload):
    """A reviewed plan creating, updating or retiring one system (kinds system_create, system_update, system_retire)."""
    from .governance import plan
    root=Path(root).resolve()
    if action not in FIELDS:raise ValueError('system-plan action must be create, update or retire')
    if not isinstance(payload,dict):raise ValueError('Payload must be a JSON object')
    extra=set(payload)-FIELDS[action]
    if extra:raise ValueError('Unknown payload fields: '+', '.join(sorted(extra)))
    slug=payload.get('slug')
    if not isinstance(slug,str) or not SLUG.fullmatch(slug):raise ValueError('slug must match [a-z0-9][a-z0-9-]{0,39}')
    with store_lock(root):
        entries=load(root)['systems'];current=next((s for s in entries if s['slug']==slug),None);others=[s for s in entries if s['slug']!=slug];stamp=now()
        slugs=[s['slug'] for s in others]
        if action=='create':
            if current:raise ValueError(f'System {slug} already exists')
            if 'name' not in payload:raise ValueError('create requires name')
            passport=payload.get('passport')
            if not isinstance(passport,dict) or not isinstance(passport.get('body'),str) or not passport['body'].strip():raise ValueError('create requires passport.body (with an Executive Summary)')
            if set(passport)-{'domain','title','body'}:raise ValueError('passport accepts domain, title and body')
            entry=_clean({k:v for k,v in payload.items() if k!='passport'},{'slug':slug,'status':'active','description':'','owners':[],'capabilities':[],'repos':[],'depends_on':[],'architecture':None,'created':stamp,'updated':stamp},slugs)
            from .notes import build_note
            from .tag_taxonomy import content
            known=read_json(root/'tag_taxonomy.json',{'tags':[]});known=known.get('tags',[]) if isinstance(known,dict) else known
            domain=_charter_domain(root,passport.get('domain'),entry['repos'],'passport.domain')
            note_id=str(uuid.uuid4());title=passport.get('title') or f"{entry['name']} passport"
            if not isinstance(title,str):raise ValueError('passport.title must be a string')
            changes={};added=tag(slug) not in known
            if added:changes['tag_taxonomy.json']=content([tag(slug)],root,allow_managed=True)[0]
            path,note,text=build_note(title,passport['body'],['subject/project','concern/architecture',tag(slug)],domain,root,'context',note_id=note_id,extra_tags=[tag(slug)])
            entry['passport']=f'{domain}:{note_id}'
            changes['systems.json']=_registry(others+[entry]);changes[path.relative_to(root).as_posix()]=text
            return plan(root,changes,'system_create',[domain],{'slug':slug,'tag':tag(slug),'added_tag':added,'passport':entry['passport'],'files':len(changes)})
        if not current:raise ValueError(f'Unknown system {slug}')
        values={'status':'retired'} if action=='retire' else {k:v for k,v in payload.items() if k!='slug'}
        entry=_clean(values,current,slugs);entry['updated']=stamp
        return plan(root,{'systems.json':_registry(others+[entry])},'system_'+action,[],{'slug':slug,'fields':sorted(values),'files':1})
```

`build_note` (`core/notes.py:270-283`) returns `(path, note, file text)` and writes nothing. The path is `<root>/domains/<domain>/notes/CONTEXT - <slug(title)>-<id[:8]>.md`. It runs `repository.validate(note,domain,root,new=True,extra_tags=...)`, which requires a `subject/` and a `concern/` tag, registered tags, an Executive Summary, and no credentials. It does **not** run capture's duplicate-title check.

**Step 7, plan file write.**

```python
# core/governance.py:8-22
def plan(root, changes, kind, domains=(), summary=None, guards=None):
    root=Path(root).resolve()
    with store_lock(root):
        expected={}
        for rel in changes:
            p=confined(root,rel)
            expected[rel]=digest(p.read_bytes()) if p.exists() else None
        value={'schema':2,'id':uuid.uuid4().hex,'kind':kind,'domains':sorted(set(domains)),
               'created':now(),'changes':changes,'expected':expected,'summary':summary or {'files':len(changes)}}
        if guards:value['guards']={k:sorted(set(v)) for k,v in guards.items() if v}
        value['digest']=hashlib.sha256(canonical_json(value).encode()).hexdigest()
        path=root/'.plans'/(value['id']+'.json');atomic_write(path,canonical_json(value))
        return {'ok':True,'plan_id':value['id'],'digest':value['digest'],'kind':kind,'summary':value['summary']}
```

`store_lock` is re-entrant per thread (`repository.py:137-153`), so the registry is read and the expected hashes are recorded under one lock.

**Step 8, output.** `cli.py:843` prints the result as compact JSON and returns 0; `_log_command` (`cli.py:852-879`) writes one operational log line.

**Step 9, review and apply.**

```powershell
& py -3.15 living_memory.py --root C:\tmp\lm-dev inspect-plan <PLAN_ID>
& py -3.15 living_memory.py --root C:\tmp\lm-dev apply <PLAN_ID> --expected-plan-sha256 <DIGEST>
```

`cli.py:719-721` calls `governance.apply`, which calls `repository.transaction(root,value['changes'],value['kind'],value['expected'],value['id'])` (`governance.py:34`), which writes the journal entry:

```python
# core/repository.py:524-529
effects.append({"path": str(Path(rel).as_posix()), "before": _encode(before), "after": _encode(after),
                "before_hash": digest(before), "after_hash": digest(after)})
...
journal = {"schema": 1, "id": operation_id, "kind": kind, "created": now(), "state": "prepared", "effects": effects}
atomic_write(journal_path, canonical_json(journal))
atomic_write(journal_path.with_name(PENDING), "pending\n")
```

Files on disk afterwards: `<root>/systems.json`, `<root>/tag_taxonomy.json` (rewritten), the passport note under `domains/<domain>/notes/`, `<root>/.plans/<id>.json`, `<root>/.operations/<id>/journal.json`.

---

## 4. Read commands

### 4.1 `systems` and `projects`

```text
systems  [--status active|deprecated|retired|any]    default any   # cli.py:404
projects [--status active|paused|archived|any]       default any   # cli.py:402
```

`--status` is the **only** flag. There is no `--slug` and no `--include-retired`: retired and archived entries are included by default, and a client filters by slug itself.

```python
# core/systems.py:104-120
def listing(root,status='any'):
    from .notes import find_note,taxonomy
    root=Path(root);known=taxonomy(root);rows=[];warnings=[];entries=load(root)['systems'];slugs={s['slug'] for s in entries}
    for s in entries:
        if status!='any' and s.get('status')!=status:continue
        who=s['slug'];dependents=sorted(o['slug'] for o in entries if who in o.get('depends_on',[]))
        row=dict(s,tag=tag(who),tag_registered=tag(who) in known,dependents=dependents);rows.append(row)
        if not row['tag_registered']:warnings.append(f"{who}: tag {row['tag']} is not in the taxonomy")
        warnings+=[f'{who}: repo folder does not exist: {r}' for r in s.get('repos',[]) if not Path(r).is_dir()]
        if s.get('architecture') and not Path(s['architecture']).is_dir():warnings.append(f"{who}: architecture folder does not exist: {s['architecture']}")
        warnings+=[f'{who}: depends on unknown system {d}' for d in s.get('depends_on',[]) if d not in slugs]
        ref=s.get('passport')
        if ref:
            try:domain,note_id=ref.split(':',1);find_note(note_id,canonical_domain(domain,root),root)
            except (ValueError,AttributeError):warnings.append(f'{who}: passport {ref} does not resolve to a note')
    return {'ok':True,'systems':rows,'warnings':warnings}
```

Output of `systems` (top-level keys in this order: `ok`, `systems`, `warnings`):

```json
{"ok":true,
 "systems":[{"architecture":"C:/work/architecture/billing","capabilities":["Take payments","Issue invoices"],
   "created":"2026-11-10T10:48:16.123456+00:00","depends_on":["ledger"],"description":"Takes payments.",
   "name":"Billing","owners":["Payments team"],"passport":"demo:6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
   "repos":["C:/work/project/billing"],"slug":"billing","status":"active",
   "updated":"2026-11-10T10:48:16.123456+00:00",
   "tag":"system/billing","tag_registered":true,"dependents":[]}],
 "warnings":["billing: architecture folder does not exist: C:/work/architecture/billing"]}
```

- **Row keys:** the stored entry's keys, alphabetical because the file is canonical JSON, followed by the derived keys `tag`, `tag_registered`, `dependents`. Output is printed without `sort_keys` (`cli.py:843`), so this order is an accident of construction, not a contract. `SCRIPT_REFERENCE.md:25` documents the key set in a different order.
- **Row order:** file order, which is slug order unless the file was edited by hand.
- **Derived fields:** `tag`, `tag_registered` (tag present in the taxonomy), `dependents` (sorted slugs of systems whose `depends_on` names this one, computed across all entries regardless of the status filter). There are **no note counts**.
- **Warnings:** plain strings prefixed `<slug>: `. Five kinds: unregistered tag, missing repo folder, missing architecture folder, unknown `depends_on` slug, passport ref that does not resolve. Warnings are computed only for rows that pass the status filter.
- **Passport resolution** uses `find_note(id, domain)`, which searches `notes/` and `archive/` of that one domain. A passport note that was promoted or remapped to another domain therefore produces a warning, even though `read` would still find it by ID.

`projects` is the same without `dependents`, the architecture warning and the `depends_on` warning (`projects.py:142-155`):

```json
{"ok":true,
 "projects":[{"aliases":["HM"],"charter":"demo:0d9a7c11-...","created":"...","description":"A demo.","name":"Hivemind",
   "repos":["C:/work/project/hive"],"slug":"hivemind","status":"active","updated":"...",
   "tag":"project/hivemind","tag_registered":true}],
 "warnings":[]}
```

A broken registry file makes both commands fail with exit 2 and `Invalid or unreadable configuration preserved: <path>`. `doctor` reports it as a warning instead (`cli.py:141-146`): `systems: <warning>` for each listing warning, or `systems.json: <error>`.

### 4.2 Actors

```python
# core/cli.py:216-219
READ_ONLY={'search','read','query','doctor','validate','history','logs','open','stats','timeline','recall','list','domains','version','links','projects','systems'}
# Viewer: a human-facing app browsing the store. Read-only, and its reads are not usage evidence for the diary.
VIEWER=READ_ONLY|{'taxonomy','review','diff','inspect-plan'}
SERVE_API=2
```

- `--actor subagent` may run only `READ_ONLY` commands. `--actor viewer` may run `VIEWER` commands.
- `systems` and `projects` are in `READ_ONLY`, so all three actors can run them (`tests/test_systems.py:107-111`).
- `system-plan`, `project-plan`, `apply` and `undo` are in neither set. A viewer gets `Viewers are read-only; run changes as --actor main` (exit 2).
- The actor defaults to the `LIVING_MEMORY_ACTOR` environment variable, else `main` (`cli.py:355`).
- Viewer commands are logged at `debug` level so polling does not flood the log (`cli.py:868`).

### 4.3 The `serve --stdio` bridge

```python
# core/cli.py:415
p=sub('serve');p.add_argument('--stdio',action='store_true',required=True,...)
# core/cli.py:452
if cmd=='serve':return serve(root,cwd,set(subs.choices)-{'serve','setup'})
```

- **A command becomes available over the bridge by being registered with `sub(name)`.** There is no separate allow-list: the served set is every subparser except `serve` and `setup`.
- The server process itself must run as `main`: `serve` is not in `READ_ONLY` or `VIEWER`, so `serve --stdio --actor viewer` exits 2 (`tests/test_app_bridge.py:65`). Each request chooses its own actor by putting `--actor viewer` or `--actor main` in its `argv`.
- **Request**, one JSON object per line on stdin, at most 2 MiB (`SERVE_LIMIT`, `cli.py:220`):

  ```json
  {"id": 7, "argv": ["system-plan", "create", "--actor", "main"], "stdin": "{\"slug\":\"billing\", ...}"}
  ```

  `argv[0]` must be a served command name; its options follow it. `stdin` is optional text that stands in for standard input.
- **Reply**, one line per request (`cli.py:343`):

  ```json
  {"id": 7, "exit_code": 0, "result": {"ok": true, "plan_id": "...", "digest": "...", "kind": "system_create", "summary": {...}, "hint": "..."}, "error": null}
  ```

  On failure `result` is `null` and `error` is `{"code": "invalid"|"conflict"|"stale"|"internal", "message": "..."}`. A malformed request gets `exit_code` 2 and `id` as far as it could be read. An argparse usage error becomes `{"code":"invalid","message":"<usage text, at most 2000 characters>"}` (`cli.py:340-342`).
- Each request runs in-process as `main(['--root',root,'--cwd',cwd]+argv)` (`cli.py:330`). **The server passes its own cwd to every request**, which is why capture ignores the cwd for attribution unless `--session` is given (`cli.py:502`).
- Requests are served one at a time. The process is long-lived, so **new code is not loaded until the server is restarted.**

### 4.4 `version`, the command list and the API number

```python
# core/cli.py:593
elif cmd=='version':result={'ok':True,'api':SERVE_API,'python':sys.version.split()[0],'commands':sorted(subs.choices)}
```

```json
{"ok":true,"api":2,"python":"3.15.0","commands":["apply","backup","batch","bind","capture", "...", "system-plan","systems","taxonomy","taxonomy-plan","timeline","undo","update","validate","version"]}
```

- **`commands`** is the sorted list of every registered subparser, including `serve` and `setup`. `commands.includes("systems")` is true because of `sub('systems')` at `cli.py:404`. A new command appears there as soon as it is registered; nothing else is needed.
- **`api`** is the constant `SERVE_API=2` at `cli.py:219`. It went from 1 to 2 in PR #21 (projects, `open`/`review --all-domains`, `list --with-summary`). **PR #26 did not change it**; its commit message says "no SERVE_API bump: the new commands are additive". `SCRIPT_REFERENCE.md:71` defines it as "bumped when the app surface changes incompatibly".
- Three tests pin the value 2: `tests/test_app_bridge.py:27`, `tests/test_app_bridge.py:79`, `tests/test_project_attribution.py:156`.

What a new read command must add to be usable by the desktop app:

1. `sub('changes')` in `main()` (makes it appear in `version.commands` and over `serve`).
2. `'changes'` in `READ_ONLY` (lets `--actor viewer` and subagents run it).
3. A dispatch branch in the `elif cmd==...` chain.
4. Optionally `'changes'` in `runtime.ALLOWED_SUBCOMMANDS` (auto-approval of the shell command for agents; irrelevant to the bridge).
5. A `SERVE_API` bump **only** if the app must gate on a number; precedent is to gate on `commands.includes(...)`.

---

## 5. CLI wiring

File: `core/cli.py` (880 lines, **starts with a UTF-8 BOM**, CRLF, lines up to 1,001 characters).

### 5.1 Where subparsers are registered

All in `main()` between `cli.py:358` and `cli.py:419`, one line per command, with the local helper `sub(name)` (`cli.py:357`), which also gives every subcommand the common options with suppressed defaults so they can follow the subcommand name.

### 5.2 Naming conventions

| Thing | Projects | Systems | Pattern |
| --- | --- | --- | --- |
| Module | `core/projects.py` | `core/systems.py` | plural noun |
| Read command | `projects` | `systems` | plural noun, `--status ...|any` default `any` |
| Write command | `project-plan` | `system-plan` | `<singular>-plan`, positional `action`, `--payload-file` |
| Plan function | `project_plan(root,action,payload)` | `system_plan(root,action,payload)` | |
| Listing function | `listing(root,status='any')` | same | imported as `listing` (`cli.py:787`, `:794`) |
| Plan kinds | `project_create|update|archive` | `system_create|update|retire` | `<singular>_<action>` |
| Registry file | `projects.json` | `systems.json` | `<plural>.json` at the store root |
| Top-level key | `projects` | `systems` | same as the file stem |
| Result key | `projects` | `systems` | same |
| Tag | `project/<slug>` | `system/<slug>` | `<singular>/<slug>` |
| Capture flag | `--project` | `--system` | repeatable facet flag |

### 5.3 Shared argument helpers

- `_payload(args)` (`cli.py:9-13`): JSON from `--payload-file` (read as plain `utf-8`, so **a file with a BOM fails to parse**) or stdin; 1 MiB cap.
- `_reference(value,domain,root)` (`cli.py:14-19`): resolves a REF to `(domain, full id)`.
- `sections_args(p,update=False)` (`cli.py:168-182`), `_file_flags(p)` (`cli.py:63-65`), `_facet_tags(args,facets)` (`cli.py:69-71`): note commands only.
- Registry commands use none of the note helpers; they take one JSON payload.

### 5.4 How handlers return JSON and errors

- A handler assigns `result`. One statement prints it: `print(json.dumps(result,ensure_ascii=False,separators=(',',':')))` and returns 0 (`cli.py:843`).
- A handler signals an error by raising. The single handler:

  ```python
  # core/cli.py:844-847
  except (OSError,ValueError,TimeoutError,KeyError,TypeError) as exc:
      message=str(exc);code=error_code(message)
      print(json.dumps({'ok':False,'error':{'code':code,'message':message}},separators=(',',':')),file=sys.stderr)
      invocation.update(code=6 if code=='stale' else 5 if code=='conflict' else 2,error={'code':code,'message':message});return invocation['code']
  ```

- The code is derived from the message text:

  ```python
  # core/cli.py:297-302
  def error_code(message):
      import re
      head=re.split(r''': |["']''',message,maxsplit=1)[0].lower()
      return 'stale' if 'stale' in head else 'conflict' if 'conflict' in head else 'invalid'
  ```

  **Rule for new messages:** the text before the first `: ` or quote decides the code. Put "stale" there for exit 6, "conflict" for exit 5, and avoid both words otherwise.

### 5.5 Exit codes

| Exit | Meaning | Examples |
| --- | --- | --- |
| 0 | success | |
| 2 | `invalid` | validation errors, `Plan digest mismatch`, `Plan unavailable`, actor refusals, argparse usage errors (usage text on stderr, not JSON) |
| 5 | `conflict` | `Undo conflicts with later edits`, `possible_duplicate conflict: ...`, `Recovery conflicts with a user edit: ...` |
| 6 | `stale` | `Stale revision: systems.json`, `stale plan: ...`, `stale_revision` |
| 1 | crash | an exception outside the five caught types; over `serve` it becomes `{"code":"internal",...}` |

---

## 6. Taxonomy and tag facets

### 6.1 Definition

```python
# core/repository.py:18
FACETS = ("subject", "concern", "platform", "technology", "project", "system")
```

`tag_taxonomy.json` at the store root:

```json
{"facets":["subject","concern","platform","technology","project","system"],"tags":["concern/architecture","project/hivemind","subject/project","system/billing"],"version":2}
```

The `facets` list is rewritten from `FACETS` on every taxonomy write (`tag_taxonomy.py:25`, `governance.py:269`, `migration.py:27`). Readers only use `tags`.

### 6.2 Validation on capture and update

`repository.validate(note,domain,root,new,extra_tags)` (`repository.py:392-440`):

- New notes need a `subject/` tag and a `concern/` tag: `Capture requires a registered subject/ tag`.
- New notes may use only known facets: `Tags must use subject/, concern/, platform/, technology/, project/, or system/ facets` (`repository.py:431`; this literal lists the facets and was edited in both registry PRs).
- Every tag must be in the taxonomy: `Unknown tags require an approved taxonomy plan: <tags>` (`repository.py:433`). This is what refuses `capture --system missing`.

Capture-time defaults (`cli.py:74-82`): `subject/project` (or `subject/user` for preferences) and a concern by type from `CONCERN_BY_TYPE`. **`plan` has no default concern**, so a plan note must name one.

### 6.3 Managed facets

- `taxonomy-plan project/x` and `taxonomy-plan system/x` are refused (`tag_taxonomy.py:20-21`). Only `content(..., allow_managed=True)`, called from the two registry modules, can add them.
- `retag-plan` accepts a `project/*` or `system/*` **target** only for a registered slug of any status: `Unregistered system tags: system/ghost; create systems with system-plan` (`governance.py:245-254`).
- Every session's injected context lists **every tag of every facet**: `Tags (pick the closest; ...): subject/{...}; project/{a,b}; system/{...}` (`runtime.py:40-48`, `:55-56`).

### 6.4 Rename and retire

- **Rename of a slug does not exist.** `update` changes `name`, never `slug`, so no note ever needs retagging because of a registry edit.
- **Retire or archive** changes only the registry status. Notes keep the tag, the tag stays valid for explicit `--system`/`--project`, and only auto-attribution stops.
- **Removing a tag** takes a `retag-plan` (`{"system/old":"system/new"}`), kind `bulk_retag`, which rewrites every note in every domain plus the taxonomy and carries an `unused_tags` guard (`governance.py:240-271`). It does not touch the registry, so the old entry then shows `tag_registered: false` with a warning.

---

## 7. Journal and undo

### 7.1 Journal entry schema

`<store root>/.operations/<operation_id>/journal.json`, canonical JSON (`repository.py:524-529`, `:660-672`):

```json
{
  "completed": "2026-11-10T10:48:16.350000+00:00",
  "created": "2026-11-10T10:48:16.300000+00:00",
  "effects": [
    {"after": "<base64 of the new bytes, or null for a delete>",
     "after_hash": "<sha256 or null>",
     "before": "<base64 of the old bytes, or null when the file did not exist>",
     "before_hash": "<sha256 or null>",
     "path": "systems.json"}
  ],
  "id": "<operation id>",
  "kind": "system_create",
  "schema": 1,
  "state": "committed"
}
```

- States: `prepared`, `applying`, `committed`, `rolling_back`, `rolled_back`, `abandoned`. Final states are `committed`, `rolled_back`, `abandoned` (`repository.py:543`).
- A `pending` file sits beside the journal while the operation is incomplete (`repository.py:537`).
- Journals of registry operations are never pruned; only `overlay_sync`, `overlay_state` and `overlay_views` are (`repository.py:540`).
- Journals hold full before and after text, so they contain note content.

### 7.2 Operation names (kinds)

| Kind | Produced by | Files |
| --- | --- | --- |
| `project_create` | `project-plan create` | `projects.json`, the charter note, `tag_taxonomy.json` if the tag was new |
| `project_update` | `project-plan update` | `projects.json` |
| `project_archive` | `project-plan archive` | `projects.json` |
| `system_create` | `system-plan create` | `systems.json`, the passport note, `tag_taxonomy.json` if the tag was new |
| `system_update` | `system-plan update` | `systems.json` |
| `system_retire` | `system-plan retire` | `systems.json` |
| `undo:<operation_id>` | `undo` then `apply` | whatever the undone operation touched |
| `taxonomy_expansion`, `bulk_retag` | `taxonomy-plan`, `retag-plan` | for comparison |

For any applied plan, `operation_id` equals the `plan_id`. Direct note operations (`capture`, `update`, `resolve`, ...) get a random operation ID and use the action name as the kind.

### 7.3 The activity listing: `history`

The command is `history [--note ID] [--limit 20]` (`cli.py:386`, `:728-730`, `governance.py:59-69`). It is in `READ_ONLY`, so viewers can call it. **Its result is a JSON array, not an object:**

```json
[
  {"operation_id":"<32 hex>","kind":"system_create","state":"committed","created":"2026-11-10T10:48:16.300000+00:00",
   "files":["domains/demo/notes/CONTEXT - billing-passport-6f0c1d2e.md","systems.json","tag_taxonomy.json"]},
  {"operation_id":"<32 hex>","kind":"system_update","state":"committed","created":"...","files":["systems.json"]}
]
```

- Newest first by `created`, cut to `--limit`.
- A row carries **no slug and no summary**. To label a registry row a client can read the plan summary with `inspect-plan <operation_id>` (the plan file still exists and the IDs match), or the real diff with `diff <operation_id>` (`cli.py:740-746`, returns `[{path, diff}]`, each diff capped at 8,000 characters). Both are viewer-allowed.
- `--note ID` keeps only operations whose effects mention that ID in their before or after bytes. The registry file holds every entry's note ref, and each operation journals the whole file, so **every later operation on `systems.json` appears in the history of every passport note**, not only the one it concerns.
- `history` parses every journal in full, so its cost grows with the store's history.

### 7.4 Undo guards

`governance.undo` (`governance.py:121-144`) and the later `apply`:

1. The operation ID must match `[A-Za-z0-9_-]{1,100}` and its journal must exist: `Invalid operation ID`, `Operation unavailable`.
2. **Every file the operation touched must still have exactly the bytes the operation left**, else `Undo conflicts with later edits` (exit 5). This is a whole-file comparison.
3. When the undo would restore an older `tag_taxonomy.json`, the tags it would drop must not be carried by any note outside the undo, else `Undo would remove tags that notes still use; retag those notes first (...)` (exit 2). The same condition is stored in the undo plan as an `unused_tags` guard and re-checked at apply, where it fails as `stale plan: ...` (exit 6) (`tests/test_projects.py:69-73`).
4. The undo is a plan. It needs `apply` with its digest, and apply re-checks the expected file hashes.
5. `undo` and `apply` are not in `READ_ONLY`/`VIEWER`: main actor only.

Guard 2 has a consequence that matters for any single-file registry: **after a second registry operation, the first one can no longer be undone**, because `systems.json` no longer holds the bytes the first operation wrote. In the same way, any later taxonomy change blocks the undo of a create, and any later edit of the charter or passport note blocks it too.

---

## 8. Files a host application would watch

All paths are relative to the store root. The root comes from `--root`, then `LIVING_MEMORY_ROOT`, then `LIVING_MEMORY_HOME`, then `data_root` in `~/.config/agentic-living-memory/config.json`, then a legacy location (`core/storage.py:80-94`). `doctor` reports it as `root`. On this machine it is `%USERPROFILE%\LivingMemory`.

| Path | What | Notes |
| --- | --- | --- |
| `projects.json` | project registry | absent until the first project exists |
| `systems.json` | system registry | absent until the first system exists |
| `tag_taxonomy.json` | controlled tag vocabulary | rewritten by registry creates |
| `bindings.json` | domains, folder prefixes, search scope, aliases | |
| `schema-version.json` | `{"version":2,"canonical_notes_rewritten":false}` | written by `migration-plan` |
| `domains/<D>/notes/*.md` | active notes | filename `<TYPE> - <title slug>-<id8>.md` |
| `domains/<D>/archive/*.md` | resolved, archived, superseded notes | |
| `domains/<D>/INDEX.md`, `ARCHIVE.md`, `.derived-dirty`, `search.sqlite3` | derived, rebuilt by `reconcile` | not canonical |
| `domains/<D>/sync-state.json`, `.last-session.json`, `staged/` | Obsidian state and sidecars | not canonical |
| `.plans/<id>.json` | plans awaiting or after approval | |
| `.operations/<id>/journal.json` (+ `pending`) | journals | the Activity feed's source |
| `.turns/` | receipts, session state, usage diary | transient, pruned after 30 days |
| `logs/log-YYYY-MM-DD.jsonl` | operational log | |
| `backups/lm-YYYYMMDD-HHMMSS.zip` | snapshots | |
| `.store.lock` | the store lock file | |

Watcher details:

- Every write goes through `atomic_write` (`core/common.py:146-156`): a temporary file named `.<name>.<random>` is created in the same folder and then renamed over the target with `os.replace`. A watcher sees a create of a dot-file followed by a rename, not an in-place modify. Match on the final name and ignore dot-prefixed temporaries.
- A registry file can be **created** (first entry) and **deleted** (undo of the first create), not only modified.
- A new registry would sit at `<store root>/changes.json`.
- `protected_rule` (`runtime.py:65-77`) makes the PreToolUse hook deny agent write tools that target `bindings.json`, `tag_taxonomy.json`, `projects.json`, `systems.json`, `.relocated.json`, the config file, or anything under `domains/`.

---

## 9. Tests

### 9.1 Files that cover the registries

**`tests/test_systems.py`** (163 lines)

- `class Fixture(StoreFixture)`: helpers `cli`, `payload`, `plan`, `apply`, `create`, `registry`, `entry`.
- `class Systems(Fixture)`: `test_create_inspect_apply`, `test_system_without_repos_lands_in_the_global_domain`, `test_dependencies_and_dependents`, `test_undo_then_create_again`, `test_undo_refused_while_notes_use_the_tag`, `test_refusals`, `test_update_and_retire_touch_only_registry`, `test_viewer`, `test_warnings`, `test_backup_and_protection`.
- `class Attribution(Fixture)`: `test_file_in_the_repo`, `test_explicit_system_wins_and_unknown_is_refused`, `test_cwd_counts_only_for_a_session`, `test_deprecated_and_retired_are_not_inferred`, `test_project_and_system_in_one_repo_both_tag`, `test_broken_registry_does_not_break_capture`.
- `class Runbook(Fixture)`: `test_runbook_type`.

**`tests/test_projects.py`** (135 lines)

- `class Projects(StoreFixture)`: `test_create_inspect_apply`, `test_undo_then_create_again`, `test_undo_refused_while_notes_use_the_tag`, `test_undo_guard_catches_tags_added_after_the_undo_plan`, `test_refusals`, `test_update_and_archive_touch_only_registry`, `test_capture_project_flag`, `test_viewer`, `test_warnings`, `test_backup_and_protection`.
- `class MatchPath(unittest.TestCase)`: `test_match`, `test_case_insensitive` (Windows only).

**`tests/test_project_attribution.py`** (158 lines): classes `Attribution` (12 tests), `Reads` (`test_open_all_domains_and_tag`, `test_review_all_domains_has_revision_and_domain`, `test_list_with_summary`), `Updated`, `SessionContext`, `Version` (`test_api`, asserts `api == 2`). Its fixture writes `projects.json` directly instead of going through a plan.

**`tests/test_app_bridge.py`** (97 lines): `class AppBridge(StoreFixture)` with `test_version_lists_commands`, `test_list_pages_filters_and_reports_revisions`, `test_list_needs_a_domain_unless_all`, `test_domains_reports_counts_and_scope`, `test_viewer_reads_leave_no_diary_and_cannot_write`, `test_serve_answers_each_request_and_survives_errors`, `test_serve_over_a_real_pipe`. No bridge test exercises `systems` or `projects`.

Related: `tests/test_links.py` (`Links`: link graph and `error_code`), `tests/test_open_work.py` (`OpenWork`: `open`, `check`, receipts), `tests/test_note_format.py` (`Layout.test_render_replaces_only_named_sections_and_keeps_custom_ones`), `tests/test_refs.py` (short refs, title lookup), `tests/test_backup.py`, `tests/test_simulation.py` (runs `tests/scenarios/*.json`).

### 9.2 Temp-store fixture and CLI invocation

```python
# tests/test_core.py:10-22
class StoreFixture(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='living-memory-test-');self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name);self.root=self.base/'store'
        quiet=patch('core.sync.QUIET_SECONDS',0);quiet.start();self.addCleanup(quiet.stop)
        homes=patch.dict('os.environ',{h.upper()+'_HOME':str(self.base/('home-'+h)) for h in ('claude','codex','copilot','factory')})
        homes.start();self.addCleanup(homes.stop)
        init_domain('demo',[str(self.base/'project')],self.root)
        (self.root/'tag_taxonomy.json').write_text(json.dumps({'tags':['subject/project','concern/architecture','concern/decision']}))
    def note(self,title='Cache',body='The local cache is rebuildable.',**kwargs):
        return capture(title,body,['subject/project','concern/architecture'],'demo',self.root,**kwargs)
```

The store is `<tmp>/store` with one bound domain `demo` whose prefix is `<tmp>/project`. Registry tests overwrite the taxonomy in their own `setUp` with the tags they need (`tests/test_systems.py:18`).

The CLI is called **in-process** with `--root`:

```python
# tests/test_systems.py:20-37
def cli(self,*argv,stdin=None,cwd=None):
    out,err=io.StringIO(),io.StringIO()
    with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err),patch('sys.stdin',io.StringIO(stdin or '')):
        try:code=main(['--root',str(self.root),*(['--cwd',str(cwd)] if cwd else []),*argv])
        except SystemExit as exc:code=exc.code
    text=out.getvalue() or err.getvalue()
    return code,(json.loads(text) if text.strip()[:1] in '{[' else text)
def payload(self,**kw):
    value={'slug':'billing','name':'Billing','repos':[str(self.repo)],'owners':['Payments team'],'capabilities':['Take payments','Issue invoices'],'description':'Takes payments.','passport':{'body':BODY}}
    value.update(kw);return value
def plan(self,action,value,actor='main'):
    return self.cli('--actor',actor,'system-plan',action,stdin=json.dumps(value))
def apply(self,plan):
    code,result=self.cli('apply',plan['plan_id'],'--expected-plan-sha256',plan['digest']);self.assertEqual(code,0,result);return result
def create(self,**kw):
    code,plan=self.plan('create',self.payload(**kw));self.assertEqual(code,0,plan);return self.apply(plan),plan
def registry(self):return json.loads((self.root/'systems.json').read_text(encoding='utf-8'))
```

Note bodies for payloads are built with `core.note_format.render(summary, details, links, actions, done, important, body)` (`tests/test_systems.py:12`). Session state for attribution tests is faked by writing `runtime._pointer(root,'s1')` (`tests/test_systems.py:141`). Serve tests feed JSON lines through a patched `sys.stdin` (`tests/test_app_bridge.py:16-21`).

### 9.3 Running the suite

```powershell
# from the repo root (VALIDATION.md:3)
py -3.15 -m unittest discover -s tests -v
# one file or one test
py -3.15 -m unittest discover -s tests -p test_systems.py -v
```

The dotted form `py -3.15 -m unittest tests.test_systems` is expected to fail (not run here): the test files import `from test_core import StoreFixture`, which needs `tests/` itself on the path, and `tests/` has no `__init__.py`.

- It is **stdlib `unittest`**. There is no pytest configuration and no third-party dependency.
- Run it from the repo root: `-s tests` puts `tests/` on the path (for `from test_core import StoreFixture`) and the working directory supplies `core`.
- Tests use temporary stores and never touch the configured store.

### 9.4 Lint, types, CI

- **None.** `.github/` holds only `CODEOWNERS` (one default owner for all files). There is no workflow, `Makefile`, `pyproject.toml`, `setup.cfg`, `tox.ini` or `requirements` file in the tracked tree.
- Other checks, all manual: `py -3.15 scripts/simulate.py` (scenario sessions through the real hook adapters; also run by `tests/test_simulation.py`), `py -3.15 scripts/eval_retrieval.py --fixture FILE` (only before changing retrieval defaults), `py -3.15 scripts/benchmark.py`, `py -3.15 scripts/installed_smoke.py [--package DIR]` (bind, capture, plan, apply, undo against an isolated temporary store).

---

## 10. Docs and release steps

### 10.1 Docs touched by PR #26

| File | What PR #26 changed | Lines now |
| --- | --- | --- |
| `SCRIPT_REFERENCE.md` | one row in the command table; one long "Systems:" paragraph | `:25`, `:35` |
| `PROTOCOL.md` | one "Systems:" line after "Projects:" | `:49` |
| `TAGGING.md` | one paragraph on the `system/` facet | `:7` |
| `NOTE_TYPES.md` | the `runbook` type (count, table row, comparison bullet) and one sentence on the passport note | `:97` for the passport sentence |

PR #21 additionally documented attribution and the `version` API in `SCRIPT_REFERENCE.md` (`:33`, `:71`).

Not touched by either registry PR, and already out of date in places:

- `README.md` does not mention projects or systems, and says "Notes have ten types" (`README.md:37`).
- `ARCHITECTURE.md` says "controlled four facets" (`:26`) and "ten note types" (`:38`).
- `RECOVERY.md:9` lists the backup's canonical set without the registry files.
- `VALIDATION.md:3` lists test coverage without the registries.
- `SCRIPT_REFERENCE.md:41` lists capture types without `map` and `runbook`.
- **There is no `CHANGELOG`.** The squash commit message is the release note.

### 10.2 Instruction blocks and hook context

- `core/instructions.py` is the single source of the managed block that installers write into `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, Copilot's `copilot-instructions.md` and Factory's `AGENTS.md`. The block is `GATE + PROTOCOL + usage()` (`instructions.py:33-37`).
- **The block does not mention projects, systems or any registry command.** The only dynamic part is `Types: {', '.join(NOTE_TYPES)}` (`instructions.py:26`).
- PR #26 changed the block text for two reasons: `runbook` joined `NOTE_TYPES`, and one sentence was shortened (`instructions.py:31`).
- `installed(harness)` (`instructions.py:58-63`) checks that the harness file contains the current block **verbatim**. If it does not, SessionStart injects the full protocol instead (`runtime.py:50-61`) and `doctor` reports the instructions as `stale_or_missing`. So **any change to the block text requires re-running `integrations/setup.py HARNESS --hooks` from the installed copy** for each harness.
- The per-session hook context (`runtime.py:54-58`, `:944`) holds `CMD = ...`, the tag list, and the line `Living Memory session=<id>`. It lists tags, not commands.
- A registry that adds no note type and no protocol sentence leaves the block unchanged, so no harness needs rewiring.

### 10.3 Version and schema constants

| Constant | Value | Where | Changed by a registry PR? |
| --- | --- | --- | --- |
| `SERVE_API` | `2` | `core/cli.py:219` | PR #21 yes (1 to 2); PR #26 no |
| registry file `version` | `1` | `projects.py:94`, `systems.py:65` | new per registry, never read |
| taxonomy `version` | `2` | `tag_taxonomy.py:25` | no |
| `schema-version.json` | `{"version":2,...}` | `migration.py:33` | no |
| note `schema_version` | `3` | `notes.py:274` | no |
| plan `schema` | `2` | `governance.py:17` | no |
| journal `schema` | `1` | `repository.py:528` | no |
| `CORE_RELEASE` | `"1.0.0"` | `core/installer_lifecycle.py:32` | no |

### 10.4 Installer flow

"Installed copy" means the package files copied to a per-user folder that belongs to no harness:

- Windows: `%LOCALAPPDATA%\agentic-living-memory\app` (`install.py:23-33`). Its plans, journals and lock sit beside `app\` in `%LOCALAPPDATA%\agentic-living-memory\` (`.plans`, `.operations`, `.store.lock`); the ownership record is `app\.core-ownership-v1.json`.
- **Hooks, the CLAUDE.md `CMD`, and anything launched from that folder run the installed copy, not the checkout.** Edits in the checkout have no effect until redeployed.

Deploy from the source checkout:

```powershell
py -3.15 install.py --plan
py -3.15 install.py --apply-plan <PLAN_ID> --expected-plan-sha256 <DIGEST>
```

- `install.py` **with no flag plans and applies in one step** (`install.py:113-115`). Use `--plan` to review first.
- The payload is every file under `core/`, `scripts/`, `hooks/`, `integrations/`, `adapters/` plus a fixed list of root documents (`installer_lifecycle.py:37-44`, `:200-236`). **A new `core/changes.py` is picked up automatically. `tests/` is not installed.** Limits: 256 files, 4 MiB per file, 32 MiB total; the tracked payload is about 70 files today.
- A new root-level document would need adding to `ROOT_DOCUMENTS`; none is needed for a registry.
- Rewire a harness only when hook wiring or the instruction block changed: from the installed copy, `py -3.15 "$env:LOCALAPPDATA\agentic-living-memory\app\integrations\setup.py" claude --hooks`, then apply the returned plan with the same arguments plus `--apply-plan ID --expected-plan-sha256 HASH`.
- Restart any long-lived `serve --stdio` process after a deploy.

### 10.5 Running the source checkout against a throwaway store

`--root` wins over everything else (`core/storage.py:80-94`). The folder need not exist beforehand.

```powershell
$store = 'C:\tmp\lm-dev'; $proj = 'C:\tmp\lm-dev-project'; New-Item -ItemType Directory -Force $proj | Out-Null
cd %USERPROFILE%\Documents\Sandbox\agentic-living-memory
py -3.15 living_memory.py --root $store bind demo $proj
py -3.15 living_memory.py --root $store migration-plan          # creates bindings v2, the default taxonomy, schema-version.json
py -3.15 living_memory.py --root $store apply <PLAN_ID> --expected-plan-sha256 <DIGEST>
py -3.15 living_memory.py --root $store --domain demo doctor
```

- Alternative: set `$env:LIVING_MEMORY_ROOT = $store` for the shell (this is what `scripts/installed_smoke.py` and `scripts/simulate.py` do).
- The default taxonomy from `migration-plan` holds `subject/project`, `subject/user`, `concern/architecture`, `concern/decision`, `concern/correction`, `concern/workflow`, `concern/preference`, `concern/knowledge` and four platform and two technology tags (`migration.py:7`).
- An agent running these in a hooked harness gets a normal permission prompt: auto-approval covers only the session's own store (`runtime.py:201-218`).
- The operational log goes to `<store>\logs\`, so the real store's log is untouched.
- A PowerShell 5.1 gotcha: `Out-File` and `>` write a BOM, and `--payload-file` is read as plain UTF-8, so a payload file written that way fails to parse. Pipe the JSON on stdin or write the file without a BOM.

---

## 11. Note model facts the new registry will lean on

### 11.1 The `plan` note type

- `'plan'` is in `NOTE_TYPES` (`note_types.py:4`). Filename `PLAN - <slug(title)>-<id[:8]>.md`, where `slug` lowercases, replaces non-alphanumerics with `-` and keeps 64 characters (`notes.py:14`).
- It gets a review date 30 days out at capture and again on every body update (`REVIEW_DAYS`, `note_types.py:34`; `notes.py:458-461`). Ticking an Action Item is a body update, so it also moves the date.
- It is one of the three `ACTION_TYPES` (`plan`, `bug`, `risk`; `note_format.py:30`): only these may have Action Items and may be resolved.
- The "unfinished state" quality warning is skipped for plan notes (`notes.py:200`).
- It has no default concern tag (section 6.2).

### 11.2 Body sections

```python
# core/note_format.py:19-28
TITLE_MARK = '# 🎯 '
SECTIONS = (('summary', '📌 Executive Summary'), ('details', '📝 Key Details'),
            ('links', '🗂️ Resource Links'), ('actions', '🟩 Action Items'))
CALLOUT = '> ℹ️ **Important Note:**'
ORDER = ['summary', 'details', 'links', 'actions', 'important']
```

- The `# 🎯 Title` heading is derived from the `title` property and is not part of the body.
- The Executive Summary is required (`note_format.py:155-156`). A body with no headings becomes the summary.
- Headings are matched on their letters only, case-insensitively (`_key`, `note_format.py:40-46`), so `## Executive Summary` in a payload is recognised and rewritten with the emoji.
- `format_body` (`note_format.py:104-140`) normalises on every write: summary first, a `---` rule after it, empty sections dropped, everything else in written order.

### 11.3 Action Items, `open`, `check`

- Syntax: `- [ ] text` and `- [x] text` under the Action Items heading. Checkboxes anywhere else are not Action Items (`_action_lines`, `note_format.py:271-283`).
- `action_items(body)` returns `[(done, text)]` in written order (`note_format.py:286-289`).
- Counting: `list --with-summary` adds `actions: {"open": n, "done": m}` for plan, bug and risk notes (`cli.py:240-246`).
- `open [--all-domains] [--tag TAG]... [--limit 50]` (`cli.py:643-655`) lists unchecked items of active plan, bug and risk notes:

  ```json
  {"ok":true,"domain":"demo","notes":2,"count":3,
   "items":[{"ref":"demo:<uuid>","short_ref":"demo:1a2b3c4d","title":"Release plan","type":"plan","updated":"2026-11-10","index":2,"item":"Write the release notes"}],
   "hint":"Tick one when done: check REF 'item text' (or --index N); --undo unticks."}
  ```

  `index` is 1-based **among all of the note's Action Items, ticked or not**.
- `check REF 'ITEM TEXT' | --index N [--undo] [--session S] [--turn T]` (`cli.py:373`, `:656-661`, `notes.py:587-614`). Exactly one of text or `--index` is required. Text matches exactly (case-insensitive) first, else as a unique substring; several matches fail with `ambiguous_item: ...`. It flips one checkbox in place as a journaled, undoable update. Result:

  ```json
  {"ok":true,"operation_id":"<32 hex>","state":"committed","idempotent":false,"id":"<uuid>","status":"update",
   "item":"Tag v2","index":3,"done":true,"open":2}
  ```

  An already-ticked item returns `"status":"unchanged"`. When the last open item is ticked, a `hint` names `resolve REF`.
- SessionStart shows an "Open work" header with the count and up to three notes with their first open item, the current project's notes first (`session_start.py:102-115`).

### 11.4 `resolve` and `reopen`

- `resolve REF [--session S]`, `reopen REF` (`cli.py:379`, `:702-708`; `notes.py:479-484`).
- `resolve` requires an **active** note of type plan, bug or risk, else `Only active plan, bug and risk notes may be resolved`. It does not require the Action Items to be done.
- It sets `status: "resolved"`, **moves the file from `notes/` to `archive/`** under the same filename, bumps `updated`, and rewrites relative Markdown links. It is a direct journaled operation of kind `resolve`: no plan, undoable.
- A resolved note leaves search, session context, `open`, and `list` with the default `--status active`. `read REF` and `find_note` still find it, and its `domain:id` ref is unchanged.
- `reopen` requires status `resolved` and moves it back.
- The same change can be obtained as a plan: `plan resolve REF` (`cli.py:382`, `notes.change(..., plan_only=True)`, `notes.py:548-550`), which builds its file set with `notes._change_set(note_id,domain,'resolve',root)`.

### 11.5 Custom sections

- **Arbitrary extra `##` sections are preserved.** `split` keeps a heading the layout does not define with key `None` and its heading text (`note_format.py:58-89`); `format_body` writes it back in place; `_with_sections` keeps it when section flags replace other sections (`note_format.py:192-193`). Covered by `tests/test_note_format.py:37-43`. `NOTE_TYPES.md:85` states it: "`##` sections of your own are kept in place".
- **Kept by:** `update` with `--summary`, `--detail`, `--link`, `--action`, `--done`, `--important`, `--add-detail`, `--add-link`, `--add-action`, `--set-detail`; `check`; `resolve`; `confirm`.
- **How to write one:** there is no flag for a custom section. Supply the whole body as Markdown:
  - capture: `capture --title 'T' --content-file FILE` (read as UTF-8, `cli.py:462`), or a JSON payload with `body`, or positional `'Title' 'Body'`;
  - update: `update REF --body 'TEXT'` or `--body-file FILE` (read as UTF-8 with optional BOM, `cli.py:600`). Both **replace the whole body**, so the client reads the note, edits the text, and sends it all back, ideally with `--expected-revision`.
  - Section flags may be combined with a body: the flags are applied on top of it (`cli.py:465`, `:607`).
- **Caveats:** only `## ` starts a section (`###` is text inside one); a custom heading whose letters equal a standard name is treated as that section; text placed after the Important Note callout becomes an untitled trailing block; an empty custom section is dropped; lines inside fenced code are never treated as headings.

### 11.6 Links between notes

- **Stored as text in the body.** A link is a `[[Title]]` wikilink anywhere in the body (by convention under Resource Links, written with `--link '[[Title]]'`). The pattern is `WIKILINK=re.compile(r'\[\[([^\]|#]+)')` (`core/sync.py:484`); text after `|` or `#` is ignored.
- **Resolved by title at query time**, case-insensitively: the linking note's domain, then its parent domains, then the global domains (`cli.py:257-295`). A link to a note in an unrelated domain does not resolve. An active note wins a title over a retired one.
- The only ID-based relations are the frontmatter fields `supersedes` and `superseded_by`.
- Ordinary relative Markdown links `[text](file.md)` are rewritten when a note is renamed or moved (`migration.rewrite_type_links`). That function handles path links only; a wikilink to a note whose title changed shows up under `unresolved`.
- `links [--all-domains] [--status active|any]` (`cli.py:413`, `:588-592`):

  ```json
  {"ok":true,"domains":["demo"],
   "nodes":[{"ref":"demo:<uuid>","id":"<uuid>","domain":"demo","title":"Cache","type":"knowledge","status":"active","tags":["concern/architecture","subject/project"]}],
   "edges":[{"from":"demo:<uuid-a>","to":"demo:<uuid-b>","kind":"link"}],
   "unresolved":[{"from":"demo:<uuid-a>","target":"Nowhere"}]}
  ```

  `kind` is `link` or `supersedes` (newer to older). At most one edge per pair; a link wins over supersedes; self-links are skipped. Nodes are sorted by `ref`, edges by `(from, to)`. There is no "what links to X" query; a client filters `edges`.

### 11.7 Refs

- A note ID is `str(uuid.uuid4())`, 36 characters (`notes.py:274`). The stable ref is `domain:id`.
- Short ref: `domain:` plus the first 8 characters (`SHORT_ID=8`, `short_ref`, `notes.py:19-22`).
- A REF argument may be (`resolve_ref`, `notes.py:39-69`): `domain:id`; `domain:` plus a unique prefix of 8 or more characters; a bare ID or prefix in the active domain; or an active note's exact title, case-insensitive, in the active and parent domains. Ambiguity fails with `ambiguous_ref: ...`.
- IDs are unique across the store. A note that was promoted or remapped keeps its ID, and `resolve_ref` finds an old `domain:id` in its new domain (`notes.py:54-60`).
- **`find_note(note_id, domain, root)` does not do that**: it looks only in the named domain (active and archive). The registries' `listing` uses `find_note`.
- Domain names may be aliases; `canonical_domain` resolves them (`common.py:75-80`). Registries store the canonical name.
- A note's `revision` is the SHA-256 of its whole file; pass it as `--expected-revision`.

---

## 12. Conventions

### 12.1 Code

- **Standard library only**, no pip dependency, no daemon (`README.md:3`).
- **Python 3.10+** is the stated floor (`README.md:9`); 3.15 is what this machine runs. Modules start with `from __future__ import annotations`.
- **Two styles coexist.** `projects.py`, `systems.py`, `cli.py`, `governance.py`, `notes.py`, `runtime.py`, `backup.py`, `tag_taxonomy.py` and the tests are dense: several statements per line joined with `;`, no spaces around `=` or after commas, single-quoted strings, one-line `def`s, lines of 200 characters and more, no type hints, a one-line docstring per public function. `repository.py`, `storage.py`, `note_format.py`, `note_types.py`, `installer_lifecycle.py` and `install.py` are conventionally formatted. **A new registry module should copy the dense style of `systems.py`.**
- Imports of sibling modules are often done inside functions to avoid cycles (`from .governance import plan` inside `system_plan`).
- Private helpers are imported across modules (`systems.py:9` imports `_charter_domain`, `_repos`, `_text`).
- Errors are `ValueError` with a human sentence; no custom exception classes in the store code.
- **`core/cli.py` and `core/runtime.py` begin with a UTF-8 BOM.** Keep it when editing.
- Working-tree files have CRLF line endings (`core.autocrlf=true`, no `.gitattributes`).
- No line-length limit, formatter or linter is configured.

### 12.2 Commits, branches, PRs

- Conventional-commit subjects: `feat:`, `fix:`, `perf:`, `test:`, lowercase, with the PR number appended by squash merge, for example `feat: system registry, system/<slug> facet and the runbook note type (#26)`.
- Body: a short paragraph on what and why, then a bullet list of the changes, wrapped at about 72 columns.
- Every commit carries a `Co-authored-by: Claude ... <noreply@anthropic.com>` trailer.
- One squash commit per PR on `main`. PR #26 came from branch `feat/systems-registry` into `main` (16 files, +360/-37).
- `.github/CODEOWNERS` assigns every file to the repository owner. No document in the repo describes branch protection or review rules, and there is no CI to gate a merge. All recent history reached `main` through numbered PRs.

---

## Conflicts and recommendations for the changes design

Each item states what in LM's mechanics makes the design awkward, what systems and projects did about the analogous problem, and a recommendation.

### C1. The registry identity is a string slug everywhere

- `load()` validates `isinstance(entry.get('slug'),str)`; `*_plan` rejects any payload whose `slug` fails `SLUG`; `_registry` sorts by `slug`; listing warnings are prefixed with the slug.
- A change is keyed by a sequential integer. None of the slug code can be reused for identity.
- **Recommendation:** store `id` as an integer, validate it in the module's own `load()`, sort by it, and add a derived `display` field (`"CHG-%03d" % id`) to listing rows the way `tag` is derived. Accept either `14` or `"CHG-014"` in update and close payloads and normalise.

### C2. Sequential IDs under concurrent plans

- A plan is computed at plan time and applied later. Two create plans built from the same registry state would both compute `max(id)+1`.
- **This is already safe.** The second apply fails with `Stale revision: changes.json` (exit 6) because the whole-file hash moved (section 3.4). Systems relies on the same check for two creates.
- The cost: the ID in a plan's summary is **provisional until apply**. After a stale failure the re-plan may be given a different number.
- **Recommendation:** allocate the ID inside `change_plan` under `store_lock`, return it in the plan summary (`summary.id`, `summary.display`), and tell callers not to use it for anything external (a branch name, a commit message) until `apply` succeeds. If `branch` embeds the ID, compute it in the create plan itself or set it with an update afterwards.

### C3. Undo of a create frees the ID

- Undo restores the exact previous bytes of `changes.json`. Whatever counter the file holds is restored too, so the next create reuses the number. A `next_id` field in the file does not help.
- Systems and projects treat this as correct behaviour: `test_undo_then_create_again` asserts that the same slug can be created again after an undo.
- Exposure is small. Undo is only possible while `changes.json` and the brief note are byte-identical to what the create left (section 7.4), which in practice means immediately.
- **Recommendation:** accept reuse and document it: "undoing a create returns its number". Make `cancelled` the normal way to abandon a change, so numbers stay monotonic in ordinary use.

### C4. Undo granularity is the whole file

- After any later write to `changes.json`, an earlier change operation cannot be undone: `Undo conflicts with later edits` (exit 5).
- A create also cannot be undone once its brief note changed, and ticking one Action Item changes it.
- Same limitation for systems and projects; their tests only ever undo the most recent operation.
- **Recommendation:** do not present undo as the way to revert a change's stage or fields. Corrections are a new `change-plan update`. Say so in the document and in the app.

### C5. One file means all change plans conflict with each other

- Any two outstanding plans against `changes.json` are mutually exclusive, even for different changes (section 3.4). Changes are edited far more often than systems (every stage move), so this will be hit.
- **Recommendation:** keep the single file (it is the pattern, and the app can watch one path). Treat exit 6 as "re-plan and re-show". Keep plans short-lived: plan, inspect, apply in one user gesture.

### C6. The brief note: create it in the plan, as charter and passport are

- Precedent: `create` takes `{domain?, title?, body}`, builds the note with `build_note(..., note_id=<new uuid>)`, and stores `domain:uuid`. `update` takes a ref string or `null`, checked for type only.
- **Recommendation:** `change-plan create` takes `brief: {domain?, title?, body}` and builds a `plan` note; `update` accepts `brief` as a ref string. If adopting an existing note at create is wanted, that is a deviation: resolve it with `notes.resolve_ref` and store the canonical `domain:full-id`.
- **Domain:** reuse `_charter_domain(root, brief.get('domain'), repos, 'brief.domain')` with `repos = [repo]` when given, else the project's `repos`.
- **Tags:** a new note needs a registered `subject/` and `concern/` tag, and `plan` has no default concern. Use `['subject/project','concern/workflow','project/<slug>']` plus `system/<slug>` when given. `concern/workflow` is in the default taxonomy, and the existing `lifecycle` scenario uses it for a plan note. If the store's taxonomy lacks the tag, create fails with `Unknown tags require an approved taxonomy plan: ...`; projects and systems have the same exposure with their hardcoded concern tags.
- **Title:** `build_note` skips capture's duplicate-title check, and exact-title REFs and `[[Title]]` links become ambiguous when two notes share a title. Prefix the brief title with the display ID (`CHG-014 Add changes registry`).
- **Side effects that come free:** a brief with unchecked Action Items appears in `open` and in every session's "Open work" for its domain; it gets a 30-day review date and shows in `review` when due; `list --type plan --tag project/<slug> --with-summary` returns it with `actions: {open, done}`.

### C7. `project`, `system`, `element`, `repo`, `branch`, `stage`

- Validate `project` against `projects.load(root)` and `system` against `systems.load(root)`, modelled on the `depends_on` check (`systems.py:47-53`): `project names an unknown project: x; create it with project-plan first`.
- The project's tag must be in the taxonomy or the brief note will not validate.
- `repo`: normalise with `_repos([repo])[0]`. `branch` and `element`: `_text(value, field, low, high)`. `stage`: a `STAGES` tuple checked like `STATUSES`.
- Run `find_secrets` over the free-text fields, as both registries do.
- A registry reference to a project or system is not maintained when that entry is archived or retired. Surface it as a listing warning, the way `depends on unknown system` is.

### C8. Status names and the terminal action

- LM's pattern: the terminal action is the verb of its status (`archive` to `archived`, `retire` to `retired`), it takes only the identity, and `update` may also set `status` to any value.
- The design has two terminal statuses (`done`, `cancelled`) and one action (`close`), so `close` needs an outcome.
- `active` is the right name for the live status: every registry uses it and attribution keys on it.
- LM's own word for a finished plan note is `resolved`.
- **Recommendation:** keep `active | done | cancelled`. Give `close` the payload `{id, status?}` with `status` defaulting to `done` and limited to the two terminal values, and let `update` change `status` as in the other registries (including back to `active`). Kinds: `change_create`, `change_update`, `change_close`. If strict pattern fidelity matters more, the alternative is `close` taking `{id}` only (meaning `done`) and `cancelled` being set through `update`.
- `--status` on the read command should follow the pattern: `--status active|done|cancelled|any`, default `any`.

### C9. Closing should resolve the brief in the same plan

- `resolve` moves the brief to `archive/` and takes it out of open work and search. If `close` leaves the brief active, a done change keeps appearing in every session.
- A plan may carry several files. `notes._change_set(note_id, domain, 'resolve', root)` returns the file changes for a resolve; merging them with the `changes.json` write and passing `[domain]` as the plan's domains gives one reviewed, undoable operation, as a create combines note, registry and taxonomy.
- Guard it: `_change_set` raises `Only active plan, bug and risk notes may be resolved` if the brief was already resolved by hand, so skip the note part in that case.
- Reopening (`update` back to `active`) would need the matching `reopen` in its plan.
- This is new ground: no existing registry action touches a note after create. Decide it explicitly.

### C10. A `change/<id>` facet is not worth its cost

What it would take: `'change'` in `FACETS`; the literal error message at `repository.py:431`; a refusal in `tag_taxonomy.content`; a registered-ID check in `retag_plan`; `CAPTURE_FACETS` and a `--change` capture flag; `TAGGING.md`; one new taxonomy tag per change.

Why not:

- **Every session's context lists every tag** (`runtime.py:40-48`). One tag per change, never removed, grows that line without bound inside a 3,500-character SessionStart budget.
- Every create would rewrite `tag_taxonomy.json`, so creates would go stale against any concurrent taxonomy, project or system plan, and their undo would be subject to the `unused_tags` guard.
- The facet idiom fits long-lived, low-cardinality things. Changes are short-lived and numerous.

**Recommendation:** no facet. Tie notes to a change through the brief: `[[CHG-014 ...]]` links from related notes (visible in `links`), the `project/<slug>` tag for grouping, and, if an explicit list is needed, a `notes` array of refs in the registry entry.

### C11. Cross-domain note refs and moved notes

- The registry is store-wide; a brief lives in one domain and is stored as `domain:id`.
- `listing` resolves refs with `find_note(id, domain)`, which does not follow a note that was promoted to `_global` or remapped. Such an entry gets a "does not resolve" warning although the note exists.
- A resolved brief still resolves (`find_note` includes `archive/`).
- **Recommendation:** in the new module resolve the brief with `notes.resolve_ref(ref, None, root)` so moved notes are found, and report the current ref in the row. This is a small, deliberate improvement over the copied pattern; state it in the document so it is not "fixed" back.

### C12. The name `changes` collides with existing vocabulary

- `changes` is the name of the file-change dict in every plan builder (`systems.py:93`, `governance.plan(root, changes, ...)`), and a top-level key of every plan file.
- `notes.change()` is the note-mutation function, and `plan` is already a CLI command for note plans (`plan update|rename|...`). `change-plan` beside `plan` and `change()` is easy to misread.
- Nothing breaks: the subcommand names `changes` and `change-plan` are unused, and `changes.json` is free.
- **Recommendation:** keep the names if the product wants them, but inside `core/changes.py` name the file dict something else (`files`), and write the docs so "change" (the entity) and "plan changes" (file effects) are not confused.

### C13. Listing extras worth deciding up front

- Systems rows carry no note-derived data. The app will probably want each change's brief title, status and Action Item counts.
- **Recommendation:** add derived fields to the row, as `dependents` is derived: `display`, and `brief_status` plus `actions: {open, done}` computed with `note_format.action_items` on the resolved brief. Keep the top-level shape `{'ok':True,'changes':rows,'warnings':warnings}`.
- Filters: `--status` and `--project SLUG` on the read command. Systems has only `--status`; a second filter flag is new but harmless.
- Warnings to emit: unknown project, unknown system, brief that does not resolve, repo folder missing.

### C14. Smaller points

- **History rows have no summary.** The app's Activity feed will show `change_update` with `files: ["changes.json"]` and nothing else. Label rows by reading `inspect-plan <operation_id>` (summary) or `diff <operation_id>`. Put `id`, `display` and `fields` in every plan summary.
- **`history --note` over-reports.** Every operation on `changes.json` journals the whole file, which contains every brief's ID, so each change operation is listed in the history of every brief (section 7.3). With many changes this makes a brief's history noisy. The app should filter a brief's history by plan summary rather than rely on `--note`.
- **Error codes come from wording** (section 5.4). Choose messages so that "already closed" and similar are `invalid`, and only real staleness says "stale".
- **Auto-approval:** add the read command to `runtime.ALLOWED_SUBCOMMANDS`, as PR #26 did for `systems`. Leave `change-plan` out, like every other `*-plan` command.
- **Backups:** without `changes.json` in `backup.TOP_LEVEL` the registry is silently left out of snapshots, and a restore zip containing it is rejected as "outside the canonical set".
- **Protection:** without `changes.json` in `runtime.protected_rule` an agent's write tool can edit it directly.
- **No instruction-block change is needed**, so no harness rewiring: the design adds no note type.
- **`SERVE_API`:** precedent says do not bump for additive commands. If the app insists on a number, bump to 3 and update the three pinned tests and `SCRIPT_REFERENCE.md:71`.

---

## Complete checklist of files a new registry must touch

Derived from commit `9ac6ea2` (PR #26, 16 files), checked against `c221bb3` (PR #21). "Runbook only" marks files PR #26 touched solely for the new note type.

### Required

| # | File | Change | Model line(s) |
| --- | --- | --- | --- |
| 1 | `core/changes.py` (new) | the registry module: constants, `load`, `_clean`, `_registry`, `change_plan`, `listing` | all of `core/systems.py` |
| 2 | `core/cli.py` | register `sub('change-plan')` with `action` choices and `--payload-file`; register `sub('changes')` with its filters | `cli.py:403-404` |
| 3 | `core/cli.py` | add `'changes'` to `READ_ONLY` | `cli.py:216` |
| 4 | `core/cli.py` | two dispatch branches, the plan one adding the standard `hint` | `cli.py:789-795` |
| 5 | `core/cli.py` | `doctor`: `changes: <warning>` lines and the `changes.json: <error>` fallback | `cli.py:144-146` |
| 6 | `core/backup.py` | add `'changes.json'` to `TOP_LEVEL` | `backup.py:21` |
| 7 | `core/runtime.py` | add `root/'changes.json'` to the protected config set | `runtime.py:74` |
| 8 | `core/runtime.py` | add `'changes'` to `ALLOWED_SUBCOMMANDS` | `runtime.py:15` |
| 9 | `tests/test_changes.py` (new) | fixture plus create/inspect/apply, undo, refusals, update and close touch only the expected files, viewer, warnings, backup and protection | all of `tests/test_systems.py` |
| 10 | `SCRIPT_REFERENCE.md` | a row in the command table and a "Changes:" paragraph with payloads, kinds and result shape | `SCRIPT_REFERENCE.md:25`, `:35` |
| 11 | `PROTOCOL.md` | one "Changes:" line after "Systems:" | `PROTOCOL.md:49` |
| 12 | `NOTE_TYPES.md` | one sentence: a change's brief is a `plan` note that `changes.json` links to | `NOTE_TYPES.md:97` |

Remember when editing: `core/cli.py` and `core/runtime.py` start with a BOM.

### Only if a `change/<id>` tag facet is added (not recommended, see C10)

| File | Change | Model line(s) |
| --- | --- | --- |
| `core/repository.py` | `FACETS`; the facet list inside the error message | `repository.py:18`, `:431` |
| `core/tag_taxonomy.py` | refuse `change/*` unless `allow_managed` | `tag_taxonomy.py:21` |
| `core/governance.py` | `retag_plan`: registered-ID check for `change/*` targets | `governance.py:250-254` |
| `core/cli.py` | `CAPTURE_FACETS` (adds `capture --change`); attribution block if wanted | `cli.py:68`, `:506-509`, `:518` |
| `TAGGING.md` | a paragraph on the facet | `TAGGING.md:7` |
| `tests/test_changes.py` | taxonomy-plan refusal, retag-plan acceptance, undo-while-tagged guard | `tests/test_systems.py:81-95` |

### Only if the app must gate on an API number

| File | Change |
| --- | --- |
| `core/cli.py:219` | `SERVE_API=3` |
| `tests/test_app_bridge.py:27`, `:79`; `tests/test_project_attribution.py:156` | expected value |
| `SCRIPT_REFERENCE.md:71` | what version 3 adds |

### Touched by PR #26 but not needed for a registry

| File | Why PR #26 touched it |
| --- | --- |
| `core/note_types.py`, `core/sync.py` | runbook only (`NOTE_TYPES`, `REVIEW_DAYS`, template prompt) |
| `core/instructions.py` | runbook lengthened the types line; one sentence shortened. Changing it forces harness rewiring |
| `core/projects.py` | refactor to share `infer_tags`, `_repos`, `_charter_domain`. A third registry imports them as they are; touch this file only to share something new |
| `core/cli.py:75` (`CONCERN_BY_TYPE`) | runbook only |

### Not touched by either PR, no change needed

`install.py` and `core/installer_lifecycle.py` (everything under `core/` ships automatically), `core/storage.py` (relocation copies every durable file), `core/migration.py`, `core/session_start.py` (unless a SessionStart line for changes is wanted), `hooks/`, `integrations/`, `README.md`, `ARCHITECTURE.md`, `RECOVERY.md`, `VALIDATION.md` (all four already lag the registries; updating them is optional tidying).

### Release steps after merge

1. `py -3.15 -m unittest discover -s tests -v` from the repo root.
2. `py -3.15 install.py --plan`, review, then `py -3.15 install.py --apply-plan ID --expected-plan-sha256 DIGEST`.
3. No `integrations/setup.py` rewiring unless `core/instructions.py` or hook wiring changed.
4. Restart the desktop app's `serve --stdio` process so it loads the new code; confirm with `version` that `commands` includes `changes` and `change-plan`.
