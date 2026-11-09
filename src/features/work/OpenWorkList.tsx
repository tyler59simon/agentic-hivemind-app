import { useMutation, useQueryClient } from "@tanstack/react-query";
import { check, type OpenItem } from "../../lib/lm";
import { classify } from "../../lib/errors";
import { recordOperation } from "../../lib/oplog";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { HoverPreview } from "../preview/HoverPreview";
import { groupOpenItems } from "./work";

function ItemBox({ item }: { item: OpenItem }) {
  const client = useQueryClient();
  const tick = useMutation({
    mutationFn: () => check(item.ref, item.index, true),
    onSuccess: (r) => {
      recordOperation(r.operation_id);
      for (const key of [["open"], ["review"], ["list"], ["note", item.ref]]) client.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  return (
    <label className="work-item">
      <input type="checkbox" className="action-box" checked={tick.isPending} disabled={tick.isPending}
        title="Mark as done" onChange={() => tick.mutate()} />
      <span>{item.item}</span>
    </label>
  );
}

/** Unchecked action items, grouped under their notes. */
export function OpenWorkList({ items }: { items: OpenItem[] }) {
  if (!items.length) return <p className="muted pad">No open action items</p>;
  return (
    <div className="work-list">
      {groupOpenItems(items).map((g) => (
        <section key={g.ref} className="work-group">
          <div className="work-head">
            <span className={`badge type-${g.type}`}>{g.type}</span>
            <HoverPreview refId={g.ref}>
              <button className="link-row" onClick={() => useWorkspace.getState().openNote(g.ref, { title: g.title })}>{g.title}</button>
            </HoverPreview>
          </div>
          {g.items.map((i) => <ItemBox key={i.index} item={i} />)}
        </section>
      ))}
    </div>
  );
}
