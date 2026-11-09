// Operation IDs Hivemind itself caused, so the activity feed can tell "you, in Hivemind" from agents.
// LM journals carry no actor, so this local log is the only record. Per device; losing it only relabels
// your own past edits as "Agent or CLI".
const KEY = "hivemind.oplog";
const CAP = 2000;

function load(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch { return []; }
}

export function recordOperation(id: string | undefined) {
  if (!id) return;
  try {
    const ids = load().filter((x) => x !== id);
    ids.push(id);
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-CAP)));
  } catch { /* storage unavailable: the feed falls back to generic labels */ }
}

export const myOperations = () => new Set(load());
