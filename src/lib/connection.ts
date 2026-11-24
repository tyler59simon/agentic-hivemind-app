import { create } from "zustand";
import type { Capabilities } from "./lm";

/** What the connected Living Memory supports (from `version`), so features can degrade gracefully. */
export const useConnection = create<{ commands: string[]; api: number; capabilities?: Capabilities; set: (v: { commands: string[]; api: number; capabilities?: Capabilities }) => void }>((set) => ({
  commands: [],
  api: 0,
  set: (v) => set(v),
}));

/** Project command centers need an LM that has the `projects` command (API 2+). */
export const useProjectsEnabled = () => useConnection((s) => s.api >= 2 && s.commands.includes("projects"));

/** The systems registry needs an LM that has the `systems` command. */
export const useSystemsEnabled = () => useConnection((s) => s.commands.includes("systems"));

/** A system's `project` field needs the `systems.project` capability (the systems command alone is not enough). */
export const useSystemProjectEnabled = () => useConnection((s) => (s.capabilities?.systems?.project ?? 0) >= 1 && s.commands.includes("systems"));

/** Custom note types need an LM that has the `types` command. */
export const useNoteTypesEnabled = () => useConnection((s) => s.commands.includes("types"));

/** Note views need an LM that has the `views` command. */
export const useViewsEnabled = () => useConnection((s) => s.commands.includes("views"));

/** Saving query views needs `views` version 2: before it, the registry holds note views only. */
export const useQueryViewsEnabled = () => useConnection((s) => (s.capabilities?.views?.version ?? 0) >= 2 && s.commands.includes("views"));

/** The domain wiki needs an LM that has the `wiki` command. */
export const useWikiEnabled = () => useConnection((s) => s.commands.includes("wiki"));

/** Living Memory notebooks (NS-2C) need the `docs` capability and the `doc` command. */
const docsOn = (s: { commands: string[]; capabilities?: Capabilities }) => (s.capabilities?.docs?.version ?? 0) >= 1 && s.commands.includes("doc");
export const useDocsEnabled = () => useConnection(docsOn);
/** The same check outside React. */
export const docsEnabled = () => docsOn(useConnection.getState());

/** Searching Living Memory's notebook pages needs `docs.search` (NS-2B); before it, the Living Memory group of the Notes
 *  search is absent. */
const docsSearchOn = (s: { commands: string[]; capabilities?: Capabilities }) => docsOn(s) && !!s.capabilities?.docs?.search;
export const useDocsSearch = () => useConnection(docsSearchOn);

/** Agent reach for folder notebooks needs `doc folder` (`docs.folder_policy`, NS-2B); notebook pages alone (NS-2A) have
 *  no such command (Codex review of 32fee20, C1). */
// Version 2: `doc folder set` keeps the fields it is not given. Hivemind registers a folder and changes one field at a
// time that way, which version 1 (`true`) refuses (Codex re-review of 75ce884, R2-C2).
const folderPolicyOn = (s: { commands: string[]; capabilities?: Capabilities }) => docsOn(s) && Number(s.capabilities?.docs?.folder_policy ?? 0) >= 2;
export const useFolderPolicyEnabled = () => useConnection(folderPolicyOn);
export const folderPolicyEnabled = () => folderPolicyOn(useConnection.getState());

/** Merging an agent's proposal writes and settles it in one operation (`proposals accept --edited`). Without it the write and
 *  the settling would be two steps, so the inbox offers only Accept and Reject (Codex review of 32fee20, D3). */
export const useAcceptEditedEnabled = () => useConnection((s) => docsOn(s) && !!s.capabilities?.docs?.accept_edited);

/** Folder notebook pages can be read and proposed to (`doc read --file`, `doc propose --file`), and their proposals settle through
 *  `proposals`: the Inbox then reads, merges and accepts them like a store notebook's (CON-9). */
const folderProposalsOn = (s: { commands: string[]; capabilities?: Capabilities }) => docsOn(s) && Number(s.capabilities?.docs?.folder_proposals ?? 0) >= 1;
export const useFolderProposalsEnabled = () => useConnection(folderProposalsOn);

/** The agent-written wiki edition needs the `wiki_agent` capability and the `wiki` command. */
export const useAgentWikiEnabled = () => useConnection((s) => (s.capabilities?.wiki_agent?.version ?? 0) >= 1 && s.commands.includes("wiki"));

/** The `history` capability level: 2 adds `log` summaries, 3 adds summary and actor to `history` rows. */
export const useHistoryLevel = () => useConnection((s) => s.capabilities?.history ?? 0);

/** Home's "since you were last here" needs history level 2 and the `recap` command. */
export const useRecapEnabled = () => useConnection((s) => (s.capabilities?.history ?? 0) >= 2 && s.commands.includes("recap"));

/** The Maintenance page needs the `maintenance` capability and command. */
export const useMaintenanceEnabled = () => useConnection((s) => (s.capabilities?.maintenance?.version ?? 0) >= 1 && s.commands.includes("maintenance"));

/** Restoring an archived note needs the `restore` capability and command. */
export const useRestoreEnabled = () => useConnection((s) => (s.capabilities?.restore ?? 0) >= 1 && s.commands.includes("restore"));

/** Pinning a note needs the `pin` capability. */
export const usePinEnabled = () => useConnection((s) => (s.capabilities?.pin ?? 0) >= 1);

/** Making a note a rule needs the `rule` capability. */
export const useRuleEnabled = () => useConnection((s) => (s.capabilities?.rule ?? 0) >= 1);

/** Whether `open` supports `--pages none` (CON-2: `items.fields >= 2`). */
export const useOpenPagesFlag = () => useConnection((s) => (s.capabilities?.items?.fields ?? 0) >= 2);

/** Hivemind writes archive, project, system and taxonomy edits as direct commands and settles proposals through `proposals`. */
export const needsLmUpdate = (v: { capabilities?: Capabilities }) =>
  (v.capabilities?.direct_writes ?? 0) < 1 || (v.capabilities?.proposals ?? 0) < 1;
