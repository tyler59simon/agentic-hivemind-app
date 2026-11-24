import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { useConnection, useNoteTypesEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { retagPlan, taxonomy, taxonomyAdd } from "../../lib/lm";
import { folderOf, notebooksQuery, pageTitle } from "../../lib/notebooks";
import { INDEX_KEY, indexSearch, tagsQuery } from "../../lib/noteindex";
import { typeClass } from "../../lib/noteTypes";
import { Modal } from "../../ui/Modal";
import { useApp } from "../../store";
import { useWorkspace } from "../../workspace/store";
import { openPage } from "../notes/actions";
import { listMemoryNotes } from "../notes/MemoryTree";
import { finishDirect, undoToast } from "../plans/DirectDialog";
import { PlanDialog } from "../plans/PlanDialog";
import { useNotesSearch } from "../search/store";
import { NoteTypesSection } from "./NoteTypesSection";
import { facetsOf, formatTagCounts, parseTags, tagUsage, type TagUsage } from "./taxonomy";

/** Rename a tag everywhere, or fold it into another existing tag (LM's retag-plan, across every domain). */
function RenameTag({ from, taxonomyTags, onClose }: { from: TagUsage; taxonomyTags: string[]; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [ready, setReady] = useState(false);
  const target = parseTags(to).tags[0];
  if (ready && target) {
    return (
      <PlanDialog title={`${from.tag} → ${target}`} make={() => retagPlan({ [from.tag]: target })} applyLabel="Retag" onClose={onClose}
        intro={<p>Every note tagged <code>{from.tag}</code> ({from.count}) gets <code>{target}</code> instead, in every domain, and the taxonomy is updated.</p>} />
    );
  }
  return (
    <Modal title={`Rename or merge ${from.tag}`} onClose={onClose}>
      <p>Pick an existing tag to merge into, or type a new name (same facet rules apply).</p>
      <input autoFocus list="retag-targets" value={to} placeholder="facet/name" onChange={(e) => setTo(e.target.value)} />
      <datalist id="retag-targets">{taxonomyTags.filter((t) => t !== from.tag).map((t) => <option key={t} value={t} />)}</datalist>
      {to && !target && <p className="error small">Use subject/, concern/, platform/ or technology/ followed by a name.</p>}
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!target || target === from.tag} onClick={() => setReady(true)}>Review plan…</button></div>
    </Modal>
  );
}

/** Unified Tags view across Living Memory notes (registered taxonomy + custom types) and folder notebook #tags (CON-12). */
export function TaxonomyView() {
  const taxEnabled = useConnection((c) => c.commands.includes("taxonomy"));
  const listEnabled = useConnection((c) => c.commands.includes("search"));
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy, enabled: taxEnabled });
  const notes = useQuery({ queryKey: ["list", "*", "any"], queryFn: ({ signal }) => listMemoryNotes(signal, "any"), enabled: listEnabled });
  const pageTags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());
  const usage = useMemo(
    () => tagUsage(tax.data?.tags ?? [], notes.data ?? [], facetsOf(tax.data), pageTags.data ?? []),
    [tax.data, notes.data, pageTags.data],
  );
  const client = useQueryClient();
  const typesOn = useNoteTypesEnabled();
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => setDialog(null);
  const facets = facetsOf(tax.data);
  const parsed = parseTags(adding, facets);

  const needle = filter.trim().replace(/^#/, "").toLowerCase();
  const matchesFilter = (t: TagUsage) => !needle || t.tag.toLowerCase().includes(needle);

  const selectedPages = useQuery({
    queryKey: [INDEX_KEY, "tag-pages", selected],
    queryFn: () => indexSearch("", { tag: selected! }, 200),
    enabled: !!selected,
  });

  const notebookNames = useMemo(
    () => new Map((notebooks.data ?? []).map((nb) => [nb.id, nb.title])),
    [notebooks.data],
  );

  /** Register tags in one direct write. LM reports close matches only after it wrote, so they go in the toast, which offers Undo. */
  const add = async (tags: string[]) => {
    setError(null);
    try {
      const receipt = await taxonomyAdd(tags);
      await finishDirect(client, receipt);
      setAdding("");
      const alternatives = (receipt.summary?.alternatives ?? {}) as Record<string, string[]>;
      const close_ = Object.entries(alternatives).filter(([, alts]) => alts.length);
      const similar = close_.map(([tag, alts]) => `${tag} is close to ${alts.join(", ")}`).join("; ");
      undoToast(client, `Added ${tags.join(", ")} to the taxonomy.${similar ? ` Similar tags exist: ${similar}.` : ""}`, receipt);
    } catch (e) { setError(classify(e).message); }
  };

  const managed = (tag: string) => tag.startsWith("project/") || tag.startsWith("system/");
  const row = (t: TagUsage, pageOnly = false) => (
    <li key={t.tag} className={`tag-row ${selected === t.tag ? "on" : ""}`}>
      <button type="button" className="link-row" onClick={() => setSelected(selected === t.tag ? null : t.tag)}>
        <span className={`tag ${t.known || pageOnly ? "" : "unknown"}`}>{pageOnly ? `#${t.tag}` : t.tag}</span>{" "}
        <span className="muted small">{formatTagCounts(t)}</span>
      </button>
      {!pageOnly && !managed(t.tag) && !t.known && <button type="button" className="ghost small" onClick={() => add([t.tag])}>Register</button>}
      {!pageOnly && !managed(t.tag) && <button type="button" className="ghost small" onClick={() => setDialog(<RenameTag from={t} taxonomyTags={tax.data?.tags ?? []} onClose={close} />)}>Rename…</button>}
    </li>
  );

  const selectedLower = selected?.toLowerCase() ?? "";
  const taggedNotes = useMemo(
    () => (selected ? (notes.data ?? []).filter((n) => n.tags.some((t) => t.toLowerCase() === selectedLower)) : []),
    [selected, selectedLower, notes.data],
  );
  const taggedPages = useMemo(
    () => (selectedPages.data?.hits ?? []).filter((h) => !notebookNames.size || notebookNames.has(h.notebook)),
    [selectedPages.data, notebookNames],
  );

  const filteredUnknown = usage.unknown.filter(matchesFilter);
  const filteredPageOnly = usage.pageOnly.filter(matchesFilter);
  const facetEntries = Object.entries(usage.byFacet).map(([facet, list]) => [facet, list.filter(matchesFilter)] as const);

  return (
    <div className="taxonomy pad">
      <div className="views-head">
        <h1>Tags</h1>
        <input className="tags-filter" aria-label="Filter tags" placeholder="Filter tags…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <p className="muted">Tags across memory notes and folder notebook pages. Memory notes require registered taxonomy tags; pages may use any <code>#tag</code>.</p>
      {taxEnabled && (
        <div className="row add-tags">
          <input value={adding} placeholder="Register taxonomy tags, e.g. platform/linux, technology/rust" onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && parsed.tags.length && !parsed.invalid.length) add(parsed.tags); }} />
          <button type="button" className="primary" disabled={!parsed.tags.length || parsed.invalid.length > 0} onClick={() => add(parsed.tags)}>Add…</button>
        </div>
      )}
      {parsed.error && <p className="error small">{parsed.error}</p>}
      {parsed.invalid.length > 0 && <p className="error small">Not valid: {parsed.invalid.join(", ")}. Tags are facet/name, with facet one of {facets.filter((f) => f !== "project").join(", ")}.</p>}
      {error && <p className="error">{error}</p>}
      {filteredUnknown.length > 0 && (
        <section className="facet warn-box">
          <h3>In use but not registered</h3>
          <p className="muted small">Memory notes with these tags cannot be saved until each tag is registered or renamed to a registered one.</p>
          <ul className="tag-list">{filteredUnknown.map((t) => row(t))}</ul>
        </section>
      )}
      {selected && (
        <section className="facet tag-results" aria-label={`Items tagged ${selected}`}>
          <div className="tag-results-head">
            <h3>
              Tagged <code>{selected}</code>{" "}
              <span className="muted small">{formatTagCounts({ count: taggedNotes.length, pageCount: taggedPages.length })}</span>
            </h3>
            <div className="row">
              <button type="button" className="ghost small" onClick={() => useNotesSearch.getState().byTag(selected)}>Open in search</button>
              <button type="button" className="ghost small" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          {taggedNotes.length > 0 && (
            <div className="tag-result-group">
              <h4>Memory notes <span className="muted small">{taggedNotes.length}</span></h4>
              {taggedNotes.map((n) => (
                <button key={n.ref} type="button" className="link-row"
                  onClick={(e) => { useApp.getState().setDomain(n.domain); useWorkspace.getState().openNote(n.ref, { title: n.title, split: e.ctrlKey || e.metaKey }); }}>
                  <span className={`badge ${typeClass(n.type)}`}>{n.type}</span> {n.title}
                  {n.status !== "active" && <span className="muted small"> · {n.status}</span>}
                </button>
              ))}
            </div>
          )}
          {selectedPages.isLoading && <p className="muted small">Loading pages…</p>}
          {taggedPages.length > 0 && (
            <div className="tag-result-group">
              <h4>Pages <span className="muted small">{taggedPages.length}</span></h4>
              {taggedPages.map((h) => {
                const detail = [notebookNames.get(h.notebook), folderOf(h.path)].filter(Boolean).join(" · ");
                return (
                  <button key={`${h.notebook}:${h.path}`} type="button" className="link-row"
                    onClick={(e) => openPage({ notebook: h.notebook, path: h.path }, { split: e.ctrlKey || e.metaKey })}>
                    <span className="badge">{h.kind}</span> {h.title || pageTitle(h.path)}
                    {detail && <span className="muted small"> · {detail}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {!taggedNotes.length && !taggedPages.length && !selectedPages.isLoading && (
            <p className="muted small">No notes or pages use this tag.</p>
          )}
        </section>
      )}
      <div className="facets-grid">
        {facetEntries.map(([facet, tags]) => (
          (!needle || tags.length > 0) && (
            <section key={facet} className="facet">
              <h3>{facet} <span className="muted small">{tags.length}</span></h3>
              {facet === "project" && <p className="muted small">Managed by projects.</p>}
              {facet === "system" && <p className="muted small">Managed by systems.</p>}
              {tags.length ? <ul className="tag-list">{tags.map((t) => row(t))}</ul> : <p className="muted small">No tags yet.</p>}
            </section>
          )
        ))}
        {(filteredPageOnly.length > 0 || (!needle && usage.pageOnly.length > 0)) && (
          <section className="facet">
            <h3>Page tags <span className="muted small">{filteredPageOnly.length}</span></h3>
            <p className="muted small">Free-form <code>#tags</code> used only on folder notebook pages.</p>
            <ul className="tag-list">{filteredPageOnly.map((t) => row(t, true))}</ul>
          </section>
        )}
      </div>
      {typesOn && <NoteTypesSection tags={tax.data?.tags ?? []} />}
      {dialog}
    </div>
  );
}
