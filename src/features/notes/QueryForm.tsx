// The form a query is made with (NS-7B): where to look (notebooks, folder, tag), conditions on properties, the order, and
// whether to show a table or a board. It holds what was typed; `specOf` turns it into the query, or says what is wrong.
import { Plus, X } from "lucide-react";
import { OPS, type Op, type QueryForm } from "./queries";

export function QueryFormFields({ form, onChange, notebooks }: { form: QueryForm; onChange: (form: QueryForm) => void; notebooks: { id: string; title: string }[] }) {
  const set = (patch: Partial<QueryForm>) => onChange({ ...form, ...patch });
  const toggle = (id: string) => set({ notebooks: form.notebooks.includes(id) ? form.notebooks.filter((n) => n !== id) : [...form.notebooks, id] });
  return (
    <form className="query-form" aria-label="Query" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>Look in</legend>
        <div className="query-notebooks">
          {notebooks.map((n) => (
            <label key={n.id}><input type="checkbox" checked={form.notebooks.includes(n.id)} onChange={() => toggle(n.id)} />{n.title}</label>
          ))}
          {!form.notebooks.length && <span className="muted small">Every notebook</span>}
        </div>
        <div className="query-row">
          <input aria-label="Folder" placeholder="Folder (optional)" value={form.folder} onChange={(e) => set({ folder: e.target.value })} />
          <input aria-label="Tag" placeholder="Tag (optional)" value={form.tag} onChange={(e) => set({ tag: e.target.value })} />
        </div>
      </fieldset>
      <fieldset>
        <legend>Where</legend>
        {form.where.map((c, i) => (
          <div key={i} className="query-row">
            <input aria-label={`Property ${i + 1}`} placeholder="property" value={c.prop} onChange={(e) => set({ where: form.where.map((w, j) => (j === i ? { ...w, prop: e.target.value } : w)) })} />
            <select aria-label={`Condition ${i + 1}`} value={c.op} onChange={(e) => set({ where: form.where.map((w, j) => (j === i ? { ...w, op: e.target.value as Op } : w)) })}>
              {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {OPS.find((o) => o.id === c.op)?.valued && <input aria-label={`Value ${i + 1}`} placeholder="value" value={c.value} onChange={(e) => set({ where: form.where.map((w, j) => (j === i ? { ...w, value: e.target.value } : w)) })} />}
            <button type="button" className="ghost icon" aria-label={`Remove condition ${i + 1}`} onClick={() => set({ where: form.where.filter((_, j) => j !== i) })}><X size="1em" aria-hidden /></button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => set({ where: [...form.where, { prop: "", op: "eq", value: "" }] })}><Plus size="1em" aria-hidden />Add a condition</button>
      </fieldset>
      <fieldset>
        <legend>Order</legend>
        {form.sort.map((s, i) => (
          <div key={i} className="query-row">
            <input aria-label={`Sort property ${i + 1}`} placeholder="property" value={s.prop} onChange={(e) => set({ sort: form.sort.map((x, j) => (j === i ? { ...x, prop: e.target.value } : x)) })} />
            <select aria-label={`Sort direction ${i + 1}`} value={s.dir} onChange={(e) => set({ sort: form.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)) })}>
              <option value="asc">Ascending</option><option value="desc">Descending</option>
            </select>
            <button type="button" className="ghost icon" aria-label={`Remove sort ${i + 1}`} onClick={() => set({ sort: form.sort.filter((_, j) => j !== i) })}><X size="1em" aria-hidden /></button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => set({ sort: [...form.sort, { prop: "", dir: "asc" }] })}><Plus size="1em" aria-hidden />Add a sort</button>
      </fieldset>
      <fieldset>
        <legend>Show as</legend>
        <div className="query-row">
          <select aria-label="View" value={form.view} onChange={(e) => set({ view: e.target.value as "table" | "board" })}>
            <option value="table">Table</option><option value="board">Board</option>
          </select>
          {form.view === "board" && <input aria-label="Group cards by" placeholder="Group cards by property" value={form.groupBy} onChange={(e) => set({ groupBy: e.target.value })} />}
          <input aria-label="Columns" placeholder="Columns: status, due" value={form.columns} onChange={(e) => set({ columns: e.target.value })} />
          <input aria-label="Limit" type="number" min={1} max={1000} value={form.limit} onChange={(e) => set({ limit: e.target.value })} />
        </div>
      </fieldset>
    </form>
  );
}
