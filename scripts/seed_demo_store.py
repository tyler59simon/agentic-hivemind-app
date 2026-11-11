"""Build a throwaway Living Memory store with demo data ("PayStream") for running Hivemind during development.

    python scripts/seed_demo_store.py --out DIR [--lm-script PATH] [--python EXE] [--architecture-example DIR]

DIR must be new, empty, or a folder this script built before (it leaves a marker file); it is wiped and rebuilt.
Every Living Memory call passes --root DIR/store, so no other store is touched. At the end it prints the three
environment variables that point `npm run tauri dev` at the demo store.
"""
import argparse, json, os, shutil, stat, subprocess, sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

MARKER = ".hivemind-demo-store"


def default_lm_script():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", "")) / "agentic-living-memory" / "app" / "living_memory.py"
    return Path.home() / ".local" / "lib" / "agentic-living-memory" / "app" / "living_memory.py"


parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--out", required=True, type=Path, help="folder to build the demo in (wiped and rebuilt)")
parser.add_argument("--lm-script", type=Path, default=default_lm_script(), help="path to living_memory.py")
parser.add_argument("--python", default=sys.executable, help="interpreter that runs Living Memory")
parser.add_argument("--architecture-example", type=Path,
                    help="an Architecture Suite output folder to copy as PayStream's (e.g. the suite's examples/payments/aws); "
                         "without it the folder holds only a small architecture-model.json")
args = parser.parse_args()

PYTHON, LM = args.python, str(args.lm_script)
ARCH_SOURCE = args.architecture_example
DEMO = args.out.resolve()
STORE, REPOS, ARCH = DEMO / "store", DEMO / "repos", DEMO / "architecture"
REPO = REPOS / "paystream"                    # git repo, bound to domain paystream
PLATFORM_DIR = REPOS / "platform"             # bound to domain platform
LEDGER_REPO = PLATFORM_DIR / "ledger-sync"
ARCH_DIR = ARCH / "paystream"

if not Path(LM).is_file():
    raise SystemExit(f"Living Memory was not found at {LM}; pass --lm-script")
if DEMO.exists() and any(DEMO.iterdir()) and not (DEMO / MARKER).is_file():
    raise SystemExit(f"Refusing to run: {DEMO} is not empty and was not built by this script")

ENV = {k: v for k, v in os.environ.items() if not k.startswith("LIVING_MEMORY_")}
ENV.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")


def lm(*argv, payload=None, check=True):
    """One Living Memory command against the demo store; returns its JSON."""
    command = [PYTHON, LM, "--root", str(STORE), *argv]
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")  # no BOM
    done = subprocess.run(command, input=data, capture_output=True, env=ENV, cwd=str(DEMO))
    out = done.stdout.decode("utf-8", "replace").strip()
    if check and done.returncode:
        raise SystemExit(f"LM failed ({done.returncode}): {' '.join(argv[:4])}\n{out}\n{done.stderr.decode('utf-8', 'replace')}")
    return json.loads(out) if out[:1] in "{[" and out else out


def apply(plan):
    return lm("apply", plan["plan_id"], "--expected-plan-sha256", plan["digest"])


def note(domain, kind, title, summary, concern, details=(), links=(), actions=(), done=(), important=None,
         tags=(), project=None, system=None, supersedes=None, files=()):
    """Capture one note in the standard section layout; returns its ref (domain:id)."""
    argv = ["capture", "--domain", domain, "--type", kind, "--title", title, "--summary", summary,
            "--tag", "subject/project", "--tag", "concern/" + concern, "--allow-similar"]
    for flag, values in (("--detail", details), ("--link", links), ("--action", actions), ("--done", done),
                         ("--tag", tags), ("--file", files)):
        for value in values:
            argv += [flag, value]
    if important: argv += ["--important", important]
    if project: argv += ["--project", project]
    if system: argv += ["--system", system]
    if supersedes: argv += ["--supersedes", supersedes]
    result = lm(*argv)
    if result.get("status") != "created":
        raise SystemExit(f"Capture of {title!r} did not create a note: {result}")
    return f"{domain}:{result['id']}"


def body(summary, details=(), links=()):
    """A charter or passport body in the standard layout (project-plan and system-plan take a body)."""
    parts = ["## 📌 Executive Summary\n" + summary]
    if details: parts.append("## 📝 Key Details\n" + "\n".join("* " + d for d in details))
    if links: parts.append("## 🗂️ Resource Links\n" + "\n".join("* " + l for l in links))
    return "\n\n---\n\n".join(parts)


def remove(path):
    def retry(function, target, _exc):  # git objects are read-only on Windows
        os.chmod(target, stat.S_IWRITE); function(target)
    if path.exists(): shutil.rmtree(path, onexc=retry)


def git(*argv, when=None):
    env = dict(os.environ)
    if when: env.update(GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    subprocess.run(["git", "-C", str(REPO), "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", *argv],
                   check=True, capture_output=True, env=env)


def commit(message, days_ago, files):
    for name, text in files.items():
        path = REPO / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text, encoding="utf-8", newline="\n")
    when = (datetime.now(timezone.utc) - timedelta(days=days_ago)).replace(microsecond=0).isoformat()
    git("add", "-A"); git("commit", "-q", "-m", message, when=when)


def write_model(folder):
    """A small architecture-model.json so the Architecture canvas has something to draw."""
    java = "Java / Spring Boot"
    elements = [
        {"id": "paystream", "name": "PayStream", "type": "software_system", "description": "Turns payment events into alerts."},
        {"id": "event-producer", "name": "Event producer", "type": "software_system", "external": True, "description": "Upstream systems that publish payment events."},
        {"id": "notification-provider", "name": "Notification provider", "type": "software_system", "external": True, "description": "Sends alerts to customers."},
        {"id": "operator", "name": "Payments operator", "type": "person", "description": "Tunes rules and watches alert volume."},
        {"id": "ingestion", "name": "Ingestion", "type": "container", "parent_id": "paystream", "technology": java, "description": "Accepts payment events and drops repeats by event ID."},
        {"id": "decisioning", "name": "Decisioning", "type": "container", "parent_id": "paystream", "technology": java, "description": "Evaluates alert rules against each accepted event."},
        {"id": "delivery", "name": "Delivery", "type": "container", "parent_id": "paystream", "technology": java, "description": "Requests alerts from the provider and retries with backoff."},
        {"id": "event-store", "name": "Event store", "type": "container", "parent_id": "paystream", "technology": "PostgreSQL", "description": "Seen event IDs and alert history."},
        {"id": "dedupe-filter", "name": "Dedupe filter", "type": "component", "parent_id": "ingestion", "technology": "Java"},
    ]
    rel = lambda i, s, d, text, tech=None: {"id": i, "source_id": s, "destination_id": d, "description": text, **({"technology": tech} if tech else {})}
    relationships = [
        rel("system-context-r1", "event-producer", "paystream", "Payment events", "Kafka"),
        rel("system-context-r2", "paystream", "notification-provider", "Alert requests", "HTTPS"),
        rel("system-context-r3", "operator", "paystream", "Tunes rules", "HTTPS"),
        rel("containers-r1", "event-producer", "ingestion", "Payment events", "Kafka"),
        rel("containers-r2", "ingestion", "decisioning", "Accepted events", "Kafka"),
        rel("containers-r3", "decisioning", "delivery", "Alert decisions", "Kafka"),
        rel("containers-r4", "delivery", "notification-provider", "Alert requests", "HTTPS"),
        rel("containers-r5", "ingestion", "event-store", "Records event IDs", "JDBC"),
        rel("containers-r6", "operator", "decisioning", "Tunes rules", "HTTPS"),
    ]
    views = [
        {"id": "system-context", "type": "context", "title": "PayStream - Context", "element_ids": ["paystream", "event-producer", "notification-provider", "operator"],
         "relationship_ids": ["system-context-r1", "system-context-r2", "system-context-r3"]},
        {"id": "containers", "type": "container", "title": "PayStream - Containers", "boundary_id": "paystream",
         "element_ids": ["paystream", "event-producer", "notification-provider", "operator", "ingestion", "decisioning", "delivery", "event-store"],
         "relationship_ids": [f"containers-r{i}" for i in range(1, 7)]},
    ]
    model = {"schema_version": "2.0", "system": {"name": "PayStream", "description": "Payment events, decisions, delivery."},
             "elements": elements, "relationships": relationships, "views": views, "gaps": [], "assumptions": []}
    (folder / "architecture-model.json").write_text(json.dumps(model, indent=2), encoding="utf-8")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    for target in (STORE, REPOS, ARCH): remove(target)
    DEMO.mkdir(parents=True, exist_ok=True); (DEMO / MARKER).write_text("Built by scripts/seed_demo_store.py; safe to delete.\n", encoding="utf-8")

    # ---- Folders: a real git repo for PayStream, plain folders for the rest, the architecture output.
    REPO.mkdir(parents=True); LEDGER_REPO.mkdir(parents=True); STORE.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(REPO)], check=True, capture_output=True)
    commit("Ingest payment events from the provider webhook", 9, {
        "README.md": "# PayStream\n\nPayment events in, alert decisions out, notifications delivered. Demo data.\n",
        "src/ingest/consumer.py": "def consume(event):\n    \"\"\"Validate a provider event and hand it to the rules engine.\"\"\"\n    return event\n",
        "src/rules/engine.py": "def evaluate(event, rules):\n    return [rule for rule in rules if rule.matches(event)]\n"})
    commit("Deduplicate alerts by event ID", 5, {
        "src/ingest/dedupe.py": "SEEN = {}\n\ndef first_time(event_id, ttl_days=14):\n    \"\"\"True once per event ID inside the retention window.\"\"\"\n    return SEEN.setdefault(event_id, True) and len(SEEN) > 0\n"})
    commit("Retry delivery with exponential backoff and jitter", 2, {
        "src/delivery/notifier.py": "def deliver(alert, provider):\n    return provider.send(alert)\n",
        "src/delivery/retry.py": "import random\n\ndef delay(attempt, base=2.0, cap=300.0):\n    return random.uniform(0, min(cap, base * 2 ** attempt))\n"})
    commit("Add restart recovery runbook", 0.2, {
        "docs/runbooks/restart-recovery.md": "# Restart recovery\n\n1. Pause delivery.\n2. Replay from the last committed offset.\n3. Resume delivery.\n"})
    if ARCH_SOURCE: shutil.copytree(ARCH_SOURCE, ARCH_DIR)
    else: ARCH_DIR.mkdir(parents=True)
    write_model(ARCH_DIR)

    # ---- Store: two bound domains and the vocabulary.
    lm("bind", "paystream", str(REPO)); lm("bind", "platform", str(PLATFORM_DIR))
    apply(lm("taxonomy-plan", "subject/project", "subject/user", "concern/architecture", "concern/decision", "concern/knowledge",
             "concern/workflow", "concern/bug", "concern/risk", "concern/planning", "concern/operations", "concern/status",
             "concern/research", "technology/kafka", "technology/postgres", "technology/redis", "platform/aws"))

    # ---- Registries: projects and systems, each with its note, through reviewed plans.
    repo = REPO.as_posix()
    apply(lm("system-plan", "create", payload={
        "slug": "notification-provider", "name": "Notification Provider",
        "description": "External SMS, email and push gateway that PayStream hands alerts to.",
        "owners": ["vendor: Relaywave"], "capabilities": ["Send SMS", "Send email", "Send push notifications"], "repos": [],
        "passport": {"domain": "platform", "body": body(
            "Notification Provider is the external gateway that delivers alerts by SMS, email and push. We do not own its code.",
            ["**Contract:** at-least-once delivery; a 504 does not mean the message was dropped",
             "**Limits:** 200 requests per second per sender, burst 400",
             "**Support:** vendor status page and a shared incident channel"])}}))
    apply(lm("project-plan", "create", payload={
        "slug": "paystream", "name": "PayStream", "description": "Payment events, decisions, delivery.", "repos": [repo],
        "charter": {"body": body(
            "PayStream turns payment events into timely, non-duplicated alerts for merchants. This charter states its goal, scope and how work is tracked.",
            ["**Goal:** every payment event produces at most one alert, delivered within 60 seconds",
             "**Scope:** ingestion, alert rules and notification delivery; ledger reconciliation is out of scope",
             "**Team:** payments-team; weekly status every Monday",
             "**Agent guidance:** read the decisions before changing ingestion or delivery; run the replay suite first"],
            ["[[Prevent duplicate payment alerts]]", "[[Extract notification delivery]]", "[[Ingestion service map]]"])}}))
    apply(lm("project-plan", "create", payload={
        "slug": "ledger-sync", "name": "Ledger Sync", "description": "Nightly reconciliation of payment events against the ledger.",
        "repos": [LEDGER_REPO.as_posix()],
        "charter": {"domain": "platform", "body": body(
            "Ledger Sync reconciles settled payment events against the finance ledger every night. It is paused until the ledger API v2 ships.",
            ["**Goal:** zero unexplained differences older than one day", "**Status:** paused; waiting on the ledger API v2"])}}))
    apply(lm("project-plan", "update", payload={"slug": "ledger-sync", "status": "paused"}))
    apply(lm("system-plan", "create", payload={
        "slug": "paystream", "name": "PayStream",
        "description": "Ingests payment events, decides which ones deserve an alert and delivers notifications to merchants.",
        "owners": ["payments-team"],
        "capabilities": ["Ingest payment events", "Evaluate alert rules", "Deliver payment notifications"],
        "repos": [repo], "depends_on": ["notification-provider"], "architecture": ARCH_DIR.as_posix(),
        "passport": {"body": body(
            "PayStream is the payments team's event pipeline: it ingests provider events, evaluates alert rules and delivers notifications.",
            ["**Runtime:** three services (ingest, rules, delivery) on a shared Kafka cluster",
             "**Data:** events are kept 30 days; idempotency keys 14 days",
             "**On call:** payments-team, business hours plus a paging rota",
             "**Depends on:** Notification Provider for SMS, email and push"],
            ["[[Restart recovery runbook]]", "[[Ingestion service map]]", "[[Use event ID as the idempotency key]]"])}}))

    # ---- PayStream notes (domain paystream, tagged project/paystream).
    P = dict(project="paystream")
    PS = dict(project="paystream", system="paystream")
    refs = {}
    refs["old_retry"] = note("paystream", "decision", "Retry policy: fixed 30-second interval",
        "Failed deliveries are retried every 30 seconds, up to 10 times.", "decision",
        ["**Why:** simple to reason about and easy to test", "**Weakness:** every failed alert retries in step, which hammers the provider during an outage"], **PS)
    refs["idempotency"] = note("paystream", "decision", "Use event ID as the idempotency key",
        "The provider's event ID is the idempotency key for alerts. A second event with the same ID never produces a second alert.", "decision",
        ["**Why:** the provider guarantees the ID is stable across redeliveries; payload hashes change when it adds fields",
         "**Rejected:** hash of merchant, amount and timestamp; two real payments can collide",
         "**Where:** checked in ingestion before the rules engine runs",
         "**Consequence:** keys must be kept as long as the provider may redeliver, see [[Key retention period]]"],
        ["[[Key retention period]]", "[[Replay behavior and retries]]"], files=["src/ingest/dedupe.py"], tags=["technology/redis"], **PS)
    refs["separate"] = note("paystream", "decision", "Keep rules separate from delivery",
        "Alert rules decide whether to alert; delivery decides how and when. Neither imports the other.", "decision",
        ["**Why:** rules change weekly with merchant requests, delivery changes with the provider; coupling made both risky to release",
         "**Boundary:** rules emit an alert record to a topic; delivery consumes it",
         "**Consequence:** delivery can move to its own service, see [[Extract notification delivery]]"],
        ["[[Extract notification delivery]]", "[[Alert rules evaluation order]]"], files=["src/rules/engine.py", "src/delivery/notifier.py"], **PS)
    refs["retry"] = note("paystream", "decision", "Retry policy: exponential backoff with jitter",
        "Failed deliveries are retried with exponential backoff and full jitter: base 2 seconds, cap 5 minutes, 8 attempts.", "decision",
        ["**Why:** fixed intervals synchronised retries and made a provider outage worse",
         "**Give up:** after 8 attempts the alert goes to the dead-letter topic and on-call is paged",
         "**Idempotency:** every retry carries the same key, see [[Use event ID as the idempotency key]]"],
        ["[[Use event ID as the idempotency key]]", "[[Replay behavior and retries]]"],
        files=["src/delivery/retry.py"], supersedes=refs["old_retry"], **PS)

    refs["risk"] = note("paystream", "risk", "Key retention period",
        "Idempotency keys expire after 14 days, but the provider may redeliver an event for up to 30 days. A late redelivery would alert twice.", "risk",
        ["**Likelihood:** low; two redeliveries older than 14 days were seen last quarter",
         "**Impact:** a duplicate alert for a payment the merchant already handled",
         "**Options:** keep keys 30 days (about 2.1x storage), or drop events older than the window"],
        ["[[Use event ID as the idempotency key]]", "[[Dedupe store options: Redis vs Postgres]]"],
        actions=["Decide between a 30-day window and rejecting late events"],
        important="Do not shorten the window below 14 days: the nightly replay relies on it.", tags=["technology/redis"], **PS)
    refs["bug"] = note("paystream", "bug", "Duplicate alert on provider timeout",
        "When the provider answers 504 after accepting a message, delivery retries and the merchant gets the alert twice.", "bug",
        ["**Cause:** the retry does not send the provider's own idempotency header, so the provider cannot recognise the repeat",
         "**Seen:** 14 merchants during the provider incident on Nov 3",
         "**Fix:** send the event ID as the provider idempotency header on every attempt"],
        ["[[Retry policy: exponential backoff with jitter]]", "[[Use event ID as the idempotency key]]"],
        actions=["Send the idempotency header on retries", "Add a 504-then-success case to the replay suite"],
        done=["Reproduce with the provider sandbox"], files=["src/delivery/retry.py"], **PS)
    refs["rate_risk"] = note("paystream", "risk", "Provider rate limit during replay",
        "A full replay after an outage can exceed the provider's 200 requests per second and get the sender throttled for an hour.", "risk",
        ["**Mitigation:** replay through the delivery queue with a 150 per second ceiling", "**Owner:** payments-team"],
        ["[[Restart recovery runbook]]", "[[Provider failover drill]]"], actions=["Add a rate ceiling flag to the replay tool"], **P)

    refs["plan_dupes"] = note("paystream", "plan", "Prevent duplicate payment alerts",
        "Make every payment event produce at most one alert, including across retries, replays and provider timeouts.", "planning",
        ["**Approach:** dedupe at ingestion by event ID, and pass the same key to the provider on delivery",
         "**Done when:** the replay suite shows zero duplicates over a 30-day sample"],
        ["[[Use event ID as the idempotency key]]", "[[Key retention period]]", "[[Duplicate alert on provider timeout]]",
         "[[Retry policy: exponential backoff with jitter]]"],
        actions=["Send the idempotency header to the provider", "Extend key retention to cover late redeliveries",
                 "Alert on-call when the duplicate rate exceeds 0.1%"],
        done=["Dedupe by event ID in ingestion", "Add duplicate counters to the delivery dashboard"], **PS)
    refs["plan_extract"] = note("paystream", "plan", "Extract notification delivery",
        "Move notification delivery out of the ingestion service into its own deployable, behind the alert topic.", "planning",
        ["**Why:** delivery incidents should not stop ingestion, and the two release on different cadences",
         "**Order:** topic contract first, then dual-run for a week, then cut over"],
        ["[[Keep rules separate from delivery]]", "[[Ingestion service map]]", "[[Provider failover drill]]"],
        actions=["Publish the alert topic contract", "Stand up the delivery service with its own deploy pipeline",
                 "Dual-run delivery for one week and compare outputs", "Cut over and remove delivery code from ingestion"], **PS)
    refs["plan_review"] = note("paystream", "plan", "Review retry policy",
        "Check whether fixed-interval retries still fit after the Nov 3 provider incident, and replace them if not.", "planning",
        ["**Outcome:** replaced by exponential backoff with jitter"],
        ["[[Retry policy: exponential backoff with jitter]]", "[[Replay behavior and retries]]"],
        actions=["Model retry load for a 20-minute provider outage", "Agree the new policy with the provider's limits"],
        done=["Collect retry timings from the Nov 3 incident"], **P)

    refs["research"] = note("paystream", "research", "Replay behavior and retries",
        "How the provider redelivers events and how our own replays and retries interact with it.", "research",
        ["**Provider redelivery:** at-least-once, with the same event ID, for up to 30 days",
         "**Our replay:** re-reads the topic from a chosen offset; safe because of [[Use event ID as the idempotency key]]",
         "**Finding:** retries and replays overlap during recovery; without jitter they arrive in waves",
         "**Open question:** whether the provider dedupes on its side when given a key"],
        ["[[Use event ID as the idempotency key]]", "[[Retry policy: exponential backoff with jitter]]", "https://example.invalid/provider/docs/redelivery"], **P)
    refs["map"] = note("paystream", "knowledge", "Ingestion service map",
        "Where each part of ingestion lives and how an event flows from the provider webhook to an alert record.", "architecture",
        ["**Entry:** src/ingest/consumer.py validates the event and checks the idempotency key",
         "**Dedupe:** src/ingest/dedupe.py, keys in Redis with a 14-day expiry",
         "**Rules:** src/rules/engine.py, pure functions over the event",
         "**Delivery:** src/delivery, to be extracted, see [[Extract notification delivery]]"],
        ["[[Extract notification delivery]]", "[[Event schema versions]]"],
        files=["src/ingest/consumer.py", "src/ingest/dedupe.py"], tags=["technology/kafka", "technology/redis"], **PS)
    refs["runbook"] = note("paystream", "runbook", "Restart recovery runbook",
        "How to bring PayStream back after a crash or a deploy that lost in-flight events, without alerting anyone twice.", "operations",
        ["**Step 1:** pause delivery (feature flag delivery.enabled)",
         "**Step 2:** find the last committed offset per partition",
         "**Step 3:** replay from that offset at no more than 150 events per second",
         "**Step 4:** check the duplicate counter stays at zero, then resume delivery",
         "**Escalate:** page payments on-call if the replay lags more than 10 minutes"],
        ["[[Replay behavior and retries]]", "[[Duplicate alert on provider timeout]]", "[[Provider rate limit during replay]]"],
        files=["docs/runbooks/restart-recovery.md"], **PS)
    refs["rules_order"] = note("paystream", "knowledge", "Alert rules evaluation order",
        "Rules run in priority order and the first matching suppress rule wins over any alert rule.", "knowledge",
        ["**Order:** suppress rules, then merchant overrides, then defaults", "**Gotcha:** a merchant override cannot re-enable a suppressed event type"],
        ["[[Keep rules separate from delivery]]"], files=["src/rules/engine.py"], **P)
    refs["signature"] = note("paystream", "knowledge", "Provider webhook signature verification",
        "Every webhook is verified against the provider's signing certificate before it is parsed; unsigned events are dropped and counted.", "knowledge",
        ["**Clock skew:** events older than 5 minutes are rejected, so replays go through the internal topic, not the webhook",
         "**Rotation:** the provider rotates its certificate quarterly and announces it two weeks ahead"],
        ["[[Ingestion service map]]"], files=["src/ingest/consumer.py"], **P)
    refs["schema"] = note("paystream", "knowledge", "Event schema versions",
        "The provider sends schema v2 and v3 side by side; ingestion normalises both to our internal event.", "knowledge",
        ["**v3 adds:** settlement currency and a refund reference", "**Rule:** unknown fields are kept, never rejected"],
        ["[[Ingestion service map]]"], tags=["technology/kafka"], **P)
    refs["store_options"] = note("paystream", "research", "Dedupe store options: Redis vs Postgres",
        "Compared Redis and Postgres for holding idempotency keys at a 30-day window.", "research",
        ["**Redis:** fastest, expiry built in; 30 days needs about 6 GB", "**Postgres:** durable and queryable; needs a nightly purge job",
         "**Leaning:** stay on Redis unless the window grows past 30 days"],
        ["[[Key retention period]]", "[[Use event ID as the idempotency key]]"], tags=["technology/redis", "technology/postgres"], **P)
    refs["oncall"] = note("paystream", "policy", "Payments on-call expectations",
        "Payments on-call acknowledges a page within 10 minutes and owns the incident until it is handed over in writing.", "workflow",
        ["**Hours:** business hours primary, paging rota outside them", "**First move:** follow [[Restart recovery runbook]] before trying anything new"],
        ["[[Restart recovery runbook]]"], **P)
    refs["cadence"] = note("paystream", "context", "PayStream stakeholders and cadence",
        "Who cares about PayStream and when they hear from us.", "knowledge",
        ["**Merchant support:** weekly digest of alert incidents", "**Finance:** monthly duplicate-alert figure", "**Platform:** told a week ahead of any Kafka topic change"], **P)
    refs["status"] = note("paystream", "status", "PayStream status: week of Nov 9",
        "Duplicate alerts are down to 0.3% after ingestion dedupe shipped; the provider-timeout bug is the main remaining source.", "status",
        ["**Shipped:** dedupe by event ID, backoff with jitter", "**In progress:** idempotency header on delivery retries",
         "**Next:** publish the alert topic contract", "**Blocked:** key retention decision"],
        ["[[Prevent duplicate payment alerts]]", "[[Extract notification delivery]]", "[[Duplicate alert on provider timeout]]", "[[Key retention period]]"], **P)
    refs["archived"] = note("paystream", "knowledge", "Legacy polling importer",
        "Before webhooks, a cron job polled the provider every five minutes for new payments. It was switched off in September.", "knowledge",
        ["**Why kept:** explains the gaps in event history before September"], **P)

    # ---- Platform notes: outside the project, two of them triage candidates for it.
    note("platform", "knowledge", "PayStream webhook traffic at the edge gateway",
        "The edge gateway allows the provider's webhook 500 requests per second and returns 429 above that.", "knowledge",
        ["**Owner:** platform team", "**Change:** raise a ticket a week ahead of an expected spike"], tags=["platform/aws"])
    note("platform", "plan", "Shared Kafka cluster upgrade window",
        "The shared Kafka cluster moves to the next major version this month; PayStream consumers must be on the new client first.", "planning",
        ["**Window:** Sunday 02:00 to 04:00 UTC", "**Rollback:** broker downgrade is supported for 7 days"],
        actions=["Confirm every consumer group is on the new client"], done=["Announce the window to service owners"], tags=["technology/kafka"])
    note("platform", "knowledge", "Service ownership registry",
        "Every production service has one owning team and one escalation contact, recorded in the service catalog.", "knowledge",
        ["**Rule:** a service without an owner is not deployed"])
    note("platform", "policy", "Certificate rotation cadence",
        "Service certificates are rotated every 90 days by the platform pipeline; teams only act when a rotation fails.", "workflow",
        ["**Alerting:** a failed rotation pages the owning team 14 days before expiry"])

    # ---- Lifecycle: finish and resolve a plan, archive a note, make two notes due for review.
    for _ in range(2): lm("check", refs["plan_review"], "--index", "1", "--domain", "paystream")
    lm("resolve", refs["plan_review"], "--domain", "paystream")
    apply(lm("plan", "archive", refs["archived"], "--domain", "paystream"))
    today = date.today()
    lm("update", refs["map"], "--domain", "paystream", "--review-by", (today - timedelta(days=12)).isoformat())
    lm("update", refs["risk"], "--domain", "paystream", "--review-by", (today - timedelta(days=3)).isoformat())

    # ---- Summary.
    cwd = ["--cwd", str(REPO)]
    domains = lm("domains"); projects = lm("projects"); systems = lm("systems")
    notes = lm("list", "--all-domains", "--status", "any", "--limit", "100")["notes"]
    project_notes = lm("list", "--all-domains", "--status", "any", "--tag", "project/paystream", "--limit", "100")["total"]
    open_work = lm("open", "--all-domains", "--tag", "project/paystream")
    review = lm("review", "--all-domains")
    links = lm("links", "--all-domains"); links_any = lm("links", "--all-domains", "--status", "any")
    doctor = lm("doctor", *cwd, check=False); version = lm("version")
    by_ref = {n["ref"]: n for n in notes}
    print("store:", STORE)
    print("domains:", ", ".join(f"{d['name']} (bound={d['bound']}, active={d['active']}, archived={d['archived']})" for d in domains["domains"]))
    print("projects:", ", ".join(f"{p['slug']} [{p['status']}] charter={p['charter'][:22]}" for p in projects["projects"]), "| warnings:", projects["warnings"])
    print("systems:", ", ".join(f"{s['slug']} [{s['status']}] depends_on={s['depends_on']} dependents={s['dependents']}" for s in systems["systems"]), "| warnings:", systems["warnings"])
    print("notes:", len(notes), "| by status:", dict(Counter(n["status"] for n in notes)), "| by type:", dict(Counter(n["type"] for n in notes)))
    print("tagged project/paystream (any status):", project_notes)
    print(f"open --tag project/paystream: {open_work['count']} items in {open_work['notes']} notes")
    print("review due:", review["due"], [n["title"] for n in review["notes"]])
    print(f"links (active): {len(links['nodes'])} nodes, {len(links['edges'])} edges, {len(links['unresolved'])} unresolved "
          f"{sorted({u['target'] for u in links['unresolved']})} | any status: {len(links_any['nodes'])} nodes, {len(links_any['edges'])} edges")
    print("doctor:", json.dumps(doctor, ensure_ascii=False)[:700])
    print("version: api", version["api"], "python", version["python"], "commands", len(version["commands"]))
    for label, key in (("superseded", "old_retry"), ("superseded by", "retry"), ("resolved plan", "plan_review"), ("archived", "archived"),
                       ("due for review", "map"), ("due for review", "risk")):
        row = by_ref[refs[key]]; print(f"{label}: {row['ref']} [{row['status']}] {row['title']}")
    print("HIVEMIND_LM_ROOT=" + str(STORE)); print("HIVEMIND_LM_SCRIPT=" + LM); print("HIVEMIND_PYTHON=" + PYTHON)


if __name__ == "__main__":
    main()
