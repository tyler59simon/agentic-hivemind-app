import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { list, retagPlan, taxonomy, taxonomyPlan, type Plan } from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { facetsOf, parseTags, tagUsage, type TagUsage } from "./taxonomy";

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

/** Tag tree with usage, adding tags, renaming/merging, and tags notes use that the taxonomy lacks. */
export function TaxonomyView() {
  const openTab = useWorkspace((s) => s.openTab);
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const notes = useQuery({ queryKey: ["list", "*", "any"], queryFn: () => list({ allDomains: true, status: "any" }) });
  const usage = useMemo(() => tagUsage(tax.data?.tags ?? [], notes.data?.notes ?? [], facetsOf(tax.data)), [tax.data, notes.data]);
  const [adding, setAdding] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => setDialog(null);
  const facets = facetsOf(tax.data);
  const parsed = parseTags(adding, facets);

  /** Make the taxonomy plan first so LM's "close match" warnings can be shown before review. */
  const add = async (tags: string[]) => {
    setError(null);
    try {
      const plan = await taxonomyPlan(tags);
      const review = () => setDialog(<PlanDialog title="Add tags to the taxonomy" make={() => Promise.resolve(plan as Plan)} applyLabel="Add tags"
        onApplied={() => setAdding("")} onClose={close} />);
      const close_ = Object.entries(plan.summary.alternatives ?? {}).filter(([, alts]) => alts.length);
      if (!close_.length) return review();
      setDialog(
        <Modal title="Similar tags already exist" onClose={close}>
          <ul>{close_.map(([tag, alts]) => <li key={tag}><code>{tag}</code> is close to {alts.map((a) => <code key={a}>{a} </code>)}</li>)}</ul>
          <p>Reusing an existing tag keeps search and filters tidy.</p>
          <div className="actions"><button onClick={close}>Go back</button><button className="primary" onClick={review}>Add anyway…</button></div>
        </Modal>,
      );
    } catch (e) { setError(classify(e).message); }
  };

  const managed = (tag: string) => tag.startsWith("project/") || tag.startsWith("system/");
  const row = (t: TagUsage) => (
    <li key={t.tag} className={`tag-row ${selected === t.tag ? "on" : ""}`}>
      <button className="link-row" onClick={() => setSelected(selected === t.tag ? null : t.tag)}>
        <span className={`tag ${t.known ? "" : "unknown"}`}>{t.tag}</span> <span className="muted small">{t.count ? `${t.count} note${t.count === 1 ? "" : "s"}` : "unused"}</span>
      </button>
      {!managed(t.tag) && !t.known && <button className="ghost small" onClick={() => add([t.tag])}>Register</button>}
      {!managed(t.tag) && <button className="ghost small" onClick={() => setDialog(<RenameTag from={t} taxonomyTags={tax.data?.tags ?? []} onClose={close} />)}>Rename…</button>}
    </li>
  );
  const tagged = selected ? (notes.data?.notes ?? []).filter((n) => n.tags.includes(selected)) : [];

  return (
    <div className="taxonomy pad">
      <h2>Tags</h2>
      <p className="muted">Living Memory only accepts registered tags. Every change here is a reviewed plan, journaled and undoable.</p>
      <div className="row add-tags">
        <input value={adding} placeholder="Add tags, e.g. platform/linux, technology/rust" onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && parsed.tags.length && !parsed.invalid.length) add(parsed.tags); }} />
        <button className="primary" disabled={!parsed.tags.length || parsed.invalid.length > 0} onClick={() => add(parsed.tags)}>Add…</button>
      </div>
      {parsed.error && <p className="error small">{parsed.error}</p>}
      {parsed.invalid.length > 0 && <p className="error small">Not valid: {parsed.invalid.join(", ")}. Tags are facet/name, with facet one of {facets.filter((f) => f !== "project").join(", ")}.</p>}
      {error && <p className="error">{error}</p>}
      {usage.unknown.length > 0 && (
        <section className="facet warn-box">
          <h3>In use but not registered</h3>
          <p className="muted small">Notes with these tags cannot be saved until each tag is registered or renamed to a registered one.</p>
          <ul className="tag-list">{usage.unknown.map(row)}</ul>
        </section>
      )}
      <div className="facets-grid">
        {Object.entries(usage.byFacet).map(([facet, tags]) => (
          <section key={facet} className="facet">
            <h3>{facet} <span className="muted small">{tags.length}</span></h3>
            {facet === "project" && <p className="muted small">Managed by projects.</p>}
            {facet === "system" && <p className="muted small">Managed by systems.</p>}
            {tags.length ? <ul className="tag-list">{tags.map(row)}</ul> : <p className="muted small">No tags yet.</p>}
          </section>
        ))}
      </div>
      {selected && (
        <section className="facet">
          <h3>Notes tagged {selected} <span className="muted small">{tagged.length}</span></h3>
          {tagged.map((n) => (
            <button key={n.ref} className="link-row" onClick={() => useWorkspace.getState().openNote(n.ref, { title: n.title })}>
              <span className={`badge type-${n.type}`}>{n.type}</span> {n.title} <span className="muted small">{n.domain}{n.status !== "active" ? ` · ${n.status}` : ""}</span>
            </button>
          ))}
          {!tagged.length && <p className="muted small">No notes use it.</p>}
        </section>
      )}
      {dialog}
      <p className="muted small">Tip: <button className="link" onClick={() => openTab({ kind: "activity" })}>Activity</button> shows past tag changes, each with Undo.</p>
    </div>
  );
}
