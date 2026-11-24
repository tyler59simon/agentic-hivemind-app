import { useState } from "react";
import { Modal } from "../../ui/Modal";
import { dropTarget, nodeLabel as label, type Node } from "./tree";

/** Move a page or section into another section without dragging it (WCAG 2.5.7, DESK-6). Sections it cannot go into (itself,
 *  its own subsections, where it already is) are left out. */
export function MoveDialog({ node, sections, onMove, onClose }: {
  node: Node; sections: Node[]; onMove: (target: Node | null) => void; onClose: () => void;
}) {
  const choices = [
    ...(dropTarget(node.path, null) ? [{ key: "", text: "Top of the notebook", target: null as Node | null }] : []),
    ...sections.filter((s) => dropTarget(node.path, s)).sort((a, b) => a.path.localeCompare(b.path)).map((s) => ({ key: s.path, text: s.path, target: s as Node | null })),
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
          <p>There is no other section to move it into.</p>
          <div className="actions"><button autoFocus onClick={onClose}>Close</button></div>
        </>
      )}
    </Modal>
  );
}
