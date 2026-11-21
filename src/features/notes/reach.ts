// Agent reach and Private for folder notebooks (NS-2C): Living Memory's policy registry decides what agents find, the
// sidecar travels with the folder, and Hivemind's registry keeps a copy for its own AI features (NS-8). A change goes
// to Living Memory first, then to the sidecar when it can be written, then to the copy.
import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { folderPolicyEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { docFolderSet, docFolderUnset, domains, type DomainInfo, type Visibility } from "../../lib/lm";
import { metaQuery, setNotebookMeta, type Notebook } from "../../lib/notebooks";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";

/** What Living Memory keeps for a folder notebook (`doc folder set` replies with it). */
export interface FolderPolicy { domain: string; visibility: Visibility; private: boolean }

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** The memory domain a folder notebook belongs to: the bound domain whose folder holds it (the longest such folder),
 *  else `fallback`. Notebook-only domains are never chosen: no agent session resolves to one. */
export function domainForFolder(path: string, known: DomainInfo[], fallback: string | null): string | null {
  const folder = norm(path);
  let best: { name: string; length: number } | null = null;
  for (const d of known) {
    if (d.kind === "notebook") continue;
    for (const prefix of d.prefixes) {
      const p = norm(prefix);
      if ((folder === p || folder.startsWith(`${p}\\`)) && (!best || p.length > best.length)) best = { name: d.name, length: p.length };
    }
  }
  return best?.name ?? fallback;
}

/** Record Living Memory's answer in Hivemind's registry. */
const record = (id: string, policy: FolderPolicy) => invoke<Notebook>("notebook_reach_record", { id, ...policy });

/** What the user changed in a folder notebook's reach; a field left out keeps what Living Memory holds. */
export interface ReachChange { visibility?: Visibility; private?: boolean }

/** Set how far agents reach into a folder notebook: only the fields in `change` (Codex review of 32fee20, P3), so a
 *  dialog opened before a newer privacy decision cannot undo it. Returns the policy Living Memory now holds. */
export async function setFolderReach(nb: Notebook, domain: string, change: ReachChange = {}): Promise<FolderPolicy> {
  const reply = await docFolderSet(nb.path, domain, change) as { folder?: Partial<FolderPolicy> };
  const policy: FolderPolicy = {
    domain: reply.folder?.domain ?? domain,
    visibility: reply.folder?.visibility ?? change.visibility ?? "searchable",
    private: reply.folder?.private ?? !!change.private,
  };
  // The sidecar is a second opinion Living Memory also reads, so it gets only what the user changed: a stricter value
  // it holds is never written over with a looser one (P1). A folder Hivemind cannot write keeps it in app data.
  const sidecar: { visibility?: Visibility; private?: boolean } = {};
  if (change.visibility !== undefined) sidecar.visibility = policy.visibility;
  if (change.private !== undefined) sidecar.private = policy.private;
  if (Object.keys(sidecar).length) await setNotebookMeta(nb.id, sidecar).catch(() => {});
  await record(nb.id, policy);
  return policy;
}

/** A folder just added as a notebook: Living Memory registers it from its domain, keeping the visibility and private
 *  flag it kept for the folder (a tombstone of one removed before) and making a new one searchable. Its sidecar is left
 *  as it is; Living Memory reads it and the stricter of the two holds (Codex review of 32fee20, P1). */
export async function registerFolder(nb: Notebook, fallback: string | null): Promise<FolderPolicy> {
  const known = await domains();
  const domain = domainForFolder(nb.path, known.domains, fallback);
  if (!domain) throw new Error("Pick a memory domain for this notebook in its settings, so agents can search it.");
  return setFolderReach(nb, domain);
}

/** A folder notebook was just added (dialog or drop): Living Memory registers it so agents can search it. A failure
 *  leaves it out of agents' reach, which is said, not hidden. */
export async function announceAdded(client: QueryClient, nb: Notebook) {
  client.invalidateQueries({ queryKey: ["notebooks"] });
  if (!folderPolicyEnabled()) { toast(`Added ${nb.title}.`); return; }
  try {
    const policy = await registerFolder(nb, useApp.getState().domain);
    client.invalidateQueries({ queryKey: ["notebooks"] });
    // Said as Living Memory judges it: the stricter of what it holds and the folder's own sidecar.
    const sidecar = await client.fetchQuery(metaQuery(nb.id)).catch(() => ({}));
    const reach = stricter(policy, sidecar as { visibility?: Visibility; private?: boolean });
    toast(reach.private || reach.visibility === "hidden"
      ? `Added ${nb.title}. Agents cannot reach it, as before; change that in its settings.`
      : `Added ${nb.title}. Agents can search it from ${policy.domain}; change that in its settings.`);
  } catch (e) {
    toast(`Added ${nb.title}, but Living Memory did not register it, so agents cannot search it yet: ${classify(e).message}`, "warn");
  }
}

/** Living Memory forgets a folder notebook that was removed from Hivemind; a hidden or private one stays out of reach. */
export const forgetFolder = (nb: Notebook) => docFolderUnset(nb.path);

/** The stricter of two policies: private, then hidden, then searchable, then injectable (Living Memory's order). */
export function stricter(a: { visibility?: Visibility; private?: boolean }, b: { visibility?: Visibility; private?: boolean }) {
  const rank: Record<Visibility, number> = { hidden: 0, searchable: 1, injectable: 2 };
  // A side without a value has no say (searchable when neither has one); a value Living Memory does not know counts
  // as hidden, as an unreadable sidecar does.
  const known = (v: Visibility): Visibility => (v in rank ? v : "hidden");
  const pick = (x?: Visibility, y?: Visibility): Visibility => {
    if (x === undefined || y === undefined) return known(x ?? y ?? "searchable");
    const xs = known(x), ys = known(y);
    return rank[xs] <= rank[ys] ? xs : ys;
  };
  return { visibility: pick(a.visibility, b.visibility), private: !!a.private || !!b.private };
}

export const REACH_TEXT: Record<Visibility, { label: string; text: string }> = {
  hidden: { label: "Hidden", text: "Agents never find these pages. Example: a journal you keep for yourself." },
  searchable: { label: "Searchable", text: "Agents find these pages when they search memory (alm search, ask). Example: design notes they may look up." },
  injectable: { label: "Injectable", text: "Living Memory also offers short labelled excerpts to agents' prompts. Example: team conventions they should always follow." },
};
