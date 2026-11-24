import { useState } from "react";
import { Modal } from "../../ui/Modal";
import { dropTarget, nodeLabel as label, type Node } from "./tree";

/** Move a page or section without dragging it (WCAG 2.5.7, DESK-6): into a section, or under a page as its subpage, as
 *  dropping it there would. Places it cannot go (itself, inside itself, where it already is) are left out, and two targets
 *  that lead to the same folder are offered once. */
export function MoveDialog({ node, targets, onMove, onClose }: {
  node: Node; targets: Node[]; onMove: (target: Node | null) => void; onClose: () => void;
}) {
  const seen = new Set<string>();
  const choices = [
    ...(dropTarget(node.path, null) ? [{ key: "", text: "Top of the notebook", target: null as Node | null }] : []),
    ...targets.filter((t) => t.kind === "dir" || t.kind === "page").sort((a, b) => a.path.localeCompare(b.path)).flatMap((t) => {
      const to = dropTarget(node.path, t);
      if (!to || seen.has(to.toLowerCase())) return [];
      seen.add(to.toLowerCase());
      return [{ key: t.path, text: t.kind === "page" ? `${t.path.replace(/\.(md|markdown|hmdoc)$/i, "")} (as a subpage)` : t.path, target: t as Node | null }];
    }),
  ];
  const [picked, setPicked] = useState(choices[0]?.key);
  const choice = choices.find((c) => c.key === picked);
  return (
    <Modal title={`Move ${label(node)}`} onClose={onClose}>
      {choices.length ? (
        <form onSubmit={(e) => { e.preventDefault(); if (choice) onMove(choice.target); }}>
          <label className="field">
            <span>Move into</span>
            <select autoFocus value={picked} onChange={(e) => setPicked(e.target.value)}>
              {choices.map((c) => <option key={c.key} value={c.key}>{c.text}</option>)}
            </select>
          </label>
          <div className="actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!choice}>Move</button>
          </div>
        </form>
      ) : (
        <>
          <p>There is no other section or page to move it to.</p>
          <div className="actions"><button autoFocus onClick={onClose}>Close</button></div>
        </>
      )}
    </Modal>
  );
}
