"""Put one fake agent session with proposed edits into Hivemind's data folder, for driving the Review page without an agent.

    python scripts/seed_review_session.py --demo DIR [--data APPDATA_DIR]
    python scripts/seed_review_session.py --demo DIR --remove

DIR is a folder built by scripts/seed_demo_store.py (it has a .hivemind-demo-store marker). The app must not be running:
it loads index.json at start and rewrites it later. Adding makes a worktree of DIR/repos/paystream with edits that are not
committed, a session log, an index.json entry and one older architecture snapshot. --remove takes all of that out again.
Nothing outside --data and the demo repository is written.
"""
import argparse, json, os, shutil, subprocess, sys, time
from pathlib import Path

MARKER = ".hivemind-demo-store"
SESSION = "00000000-0000-4000-8000-0000000000d4"
SHORT = "00000000"
BRANCH = f"hivemind/{SHORT}"
TITLE = "Make event consumption idempotent"


def default_data():
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", "")) / "dev.hivemind.app"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "dev.hivemind.app"
    return Path.home() / ".local" / "share" / "dev.hivemind.app"


parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--demo", required=True, type=Path, help="a folder built by seed_demo_store.py")
parser.add_argument("--data", type=Path, default=default_data(), help="the app's data folder (default: the real one)")
parser.add_argument("--remove", action="store_true", help="take the fake session out again")
args = parser.parse_args()

DEMO, DATA = args.demo.resolve(), args.data.resolve()
REPO = DEMO / "repos" / "paystream"
SESSIONS = DATA / "agent-sessions"
INDEX = SESSIONS / "index.json"
LOG = SESSIONS / f"{SESSION}.jsonl"
FOLDER = DATA / "worktrees" / f"paystream-{SHORT}"
TREE = FOLDER / SHORT
SNAP_DIR = DATA / "architecture-snapshots" / "paystream"

CONSUMER = '''"""Consume provider events once each."""
from .idempotency import first_time


class Rejected(Exception):
    pass


def consume(event, rules=None, seen=None):
    """Validate a provider event, drop repeats by event ID and hand the rest on."""
    if "id" not in event:
        raise Rejected("event has no id")
    if not first_time(event["id"], seen):
        return None
    if rules is None:
        return event
    return [rule for rule in rules if rule.matches(event)]
'''
IDEMPOTENCY = '''SEEN = {}


def first_time(event_id, seen=None):
    """True once per event ID; the caller may pass its own store."""
    store = SEEN if seen is None else seen
    if event_id in store:
        return False
    store[event_id] = True
    return True
'''


def git(*argv, cwd=REPO):
    done = subprocess.run(["git", *argv], cwd=str(cwd), capture_output=True)
    if done.returncode:
        raise SystemExit(f"git {' '.join(argv)} failed: {done.stderr.decode('utf-8', 'replace').strip()}")
    return done.stdout.decode("utf-8", "replace").strip()


def read_index():
    return json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.is_file() else []


def write_index(entries):
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def snapshot_files():
    return list(SNAP_DIR.glob(f"*-{SESSION}.json")) if SNAP_DIR.is_dir() else []


def lines(text):
    return len(text.splitlines())


def add():
    if any(e.get("id") == SESSION for e in read_index()) or TREE.exists():
        raise SystemExit("The fake session is already there; run it with --remove first.")
    now = int(time.time() * 1000)
    base = git("rev-parse", "main")
    git("worktree", "add", "-b", BRANCH, str(TREE), "main")
    old = git("show", "main:src/ingest/consumer.py").replace("\r", "")
    (TREE / "src/ingest/consumer.py").write_text(CONSUMER, encoding="utf-8", newline="\n")
    (TREE / "src/ingest/idempotency.py").write_text(IDEMPOTENCY, encoding="utf-8", newline="\n")
    gone = git("show", "main:src/rules/engine.py").replace("\r", "")
    (TREE / "src/rules/engine.py").unlink()
    # Line counts as git reports them for the edits just made.
    consumer = [l for l in git("diff", "--numstat", "--", "src/ingest/consumer.py", cwd=TREE).split() if l.isdigit()]
    files = [
        {"path": "src/ingest/consumer.py", "status": "M", "added": int(consumer[0]), "removed": int(consumer[1]), "binary": False},
        {"path": "src/ingest/idempotency.py", "status": "A", "added": lines(IDEMPOTENCY), "removed": 0, "binary": False},
        {"path": "src/rules/engine.py", "status": "D", "added": 0, "removed": lines(gone), "binary": False},
    ]
    totals = {"files": 3, "added": sum(f["added"] for f in files), "removed": sum(f["removed"] for f in files)}

    # The log: what the CLI printed (raw), then two records Hivemind wrote itself.
    t = now - 600_000
    tool_use = lambda name, i, inp: {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}}
    tool_result = lambda i, text: {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": text}]}}
    pytest_text = "\n".join([f"tests/test_case_{n:02d}.py ." for n in range(1, 58)] + ["", "", "12 passed in 0.41s"])
    raws = [
        {"type": "system", "subtype": "init", "session_id": SESSION, "model": "claude-sonnet-4-5", "claude_code_version": "2.1.322", "plugins": []},
        tool_use("Edit", "toolu_seed_1", {"file_path": str(TREE / "src/ingest/consumer.py"), "old_string": "return event", "new_string": "..."}),
        tool_result("toolu_seed_1", "The file src/ingest/consumer.py has been updated."),
        tool_use("Bash", "toolu_seed_2", {"command": "python -m pytest -q"}),
        tool_result("toolu_seed_2", pytest_text),
        tool_use("Write", "toolu_seed_3", {"file_path": str(TREE / "src/ingest/idempotency.py"), "content": IDEMPOTENCY}),
        tool_result("toolu_seed_3", "File created successfully at: src/ingest/idempotency.py"),
        {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "duration_ms": 19800, "total_cost_usd": 0.04, "result": "Consumption is idempotent."},
    ]
    records = [{"at": t + i * 1000, "raw": json.dumps(r)} for i, r in enumerate(raws)]
    records.append({"at": t + 20_000, "event": {"type": "filesChanged", "files": files}})
    records.append({"at": t + 20_001, "event": {"type": "turnFinished", "ok": True, "reason": None, "costUsd": 0.04, "durationMs": 19800,
                                                   "result": "Consumption is idempotent.", "denials": 0, "outcome": "completed"}})
    SESSIONS.mkdir(parents=True, exist_ok=True)
    LOG.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")

    entry = {
        "id": SESSION, "adapter": "claude-code", "cliVersion": "2.1.322",
        "task": {"kind": "work", "project": "paystream", "repo": REPO.as_posix()},
        "title": TITLE, "workspace": [str(TREE)], "status": "idle", "startedAt": t, "endedAt": None, "costUsd": 0.04, "error": None, "structured": None,
        "mode": "interactive", "policy": "ask", "project": "paystream",
        "worktree": {"repo": REPO.as_posix(), "path": str(TREE), "branch": BRANCH, "baseBranch": "main", "baseSha": base},
        "turns": 1, "filesChanged": totals, "context": [], "model": None, "system": "paystream", "review": None,
    }
    write_index([*read_index(), entry])

    # One older baseline for Compare: no event-store box, no containers-r5 arrow, and delivery on another technology.
    model_file = DEMO / "architecture" / "paystream" / "architecture-model.json"
    if model_file.is_file():
        model = json.loads(model_file.read_text(encoding="utf-8"))
        model["elements"] = [e for e in model["elements"] if e["id"] != "event-store"]
        for e in model["elements"]:
            if e["id"] == "delivery": e["technology"] = "Java"
        model["relationships"] = [r for r in model["relationships"] if r["id"] != "containers-r5"]
        taken = now - 3 * 86_400_000
        SNAP_DIR.mkdir(parents=True, exist_ok=True)
        (SNAP_DIR / f"{taken}-{SESSION}.json").write_text(
            json.dumps({"sessionId": SESSION, "takenAt": taken, "sourceSha": None, "model": model}, indent=2), encoding="utf-8")
    print(SESSION)


def remove():
    for f in snapshot_files(): f.unlink()
    if SNAP_DIR.is_dir() and not any(SNAP_DIR.iterdir()): SNAP_DIR.rmdir()
    if INDEX.is_file():
        write_index([e for e in read_index() if e.get("id") != SESSION])
    LOG.unlink(missing_ok=True)
    if TREE.exists():
        git("worktree", "remove", "--force", str(TREE))
    git("worktree", "prune")
    if git("branch", "--list", BRANCH):
        git("branch", "-D", BRANCH)
    if FOLDER.is_dir() and not any(FOLDER.iterdir()): FOLDER.rmdir()
    print(f"Removed {SESSION}")


if not (DEMO / MARKER).is_file():
    raise SystemExit(f"Refusing to run: {DEMO} has no {MARKER} file; build it with scripts/seed_demo_store.py")
if not (REPO / ".git").exists():
    raise SystemExit(f"{REPO} is not a git repository")
remove() if args.remove else add()
