// Notes > People (CON-15): sets up where the People pages live, lists the people with their open and overdue tasks, and
// lists the owners that have no page yet.
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { openPage } from "../notes/actions";
import { DEFAULT_PEOPLE_FOLDER, cleanFolder, type PeopleLocation } from "./people";
import { createPerson, setPeopleLocation, useOwnedItems, usePeople } from "./usePeople";

function SetupForm({ current, onDone, onAdd }: { current: PeopleLocation | null; onDone: () => void; onAdd: () => void }) {
  const client = useQueryClient();
  const { notebooks, metas } = usePeople();
  const [notebook, setNotebook] = useState(current?.notebook ?? "");
  const [folder, setFolder] = useState(current?.folder ?? DEFAULT_PEOPLE_FOLDER);
  if (!notebooks.length) {
    return (
      <div className="people-setup">
        <p>People pages live in a folder of a folder notebook. Add a notebook first.</p>
        <button className="primary" onClick={onAdd}><Plus size="1.1em" aria-hidden />Add a notebook</button>
      </div>
    );
  }
  const chosen = notebook || notebooks[0].id;
  const save = async () => {
    try {
      await setPeopleLocation(client, notebooks, metas, chosen, cleanFolder(folder) || DEFAULT_PEOPLE_FOLDER);
      onDone();
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  return (
    <form className="people-setup" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>People pages are Markdown pages, one per person, in a folder of one of your notebooks.</p>
      <label>Notebook
        <select value={chosen} onChange={(e) => setNotebook(e.target.value)}>
          {notebooks.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
        </select>
      </label>
      <label>Folder
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={DEFAULT_PEOPLE_FOLDER} />
      </label>
      <div className="actions">
        {current && <button type="button" onClick={onDone}>Cancel</button>}
        <button type="submit" className="primary">Save</button>
      </div>
    </form>
  );
}

function NewPerson({ location, onClose }: { location: PeopleLocation; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onClose();
    createPerson(client, location, name).catch((e) => toast(classify(e).message, "error"));
  };
  return (
    <Modal title="New person" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>Create page</button>
        </div>
      </form>
    </Modal>
  );
}

/** `onAdd` is the Add a notebook action of the Notes page. */
export function PeoplePane({ onAdd }: { onAdd: () => void }) {
  const client = useQueryClient();
  const { owned, unmatched, location, loading, problems } = useOwnedItems();
  const [changing, setChanging] = useState(false);
  const [creating, setCreating] = useState(false);
  const head = <div className="section-head"><h1><Users size="1em" aria-hidden /> People</h1></div>;
  if (loading && !location) return <div className="people-pane">{head}<p className="muted" role="status">Loading…</p></div>;
  if (!location || changing) return <div className="people-pane">{head}<SetupForm current={location} onDone={() => setChanging(false)} onAdd={onAdd} /></div>;
  const create = (name: string) => createPerson(client, location, name).catch((e) => toast(classify(e).message, "error"));
  return (
    <div className="people-pane">
      <div className="section-head">
        <h1><Users size="1em" aria-hidden /> People</h1>
        <button onClick={() => setCreating(true)}><Plus size="1.1em" aria-hidden />New person</button>
      </div>
      <p className="muted small">Pages in <code>{location.folder}</code>. <button type="button" className="link" onClick={() => setChanging(true)}>Change location</button></p>
      {problems.map((p) => <p key={p} className="error small">{p}</p>)}
      {!owned.length && <p className="muted">No one yet. Create a page for a person, or for an owner listed below.</p>}
      <ul className="people-list plain-list">
        {owned.map(({ person, items, overdue }) => (
          <li key={person.path}>
            <button type="button" className="link" onClick={() => openPage({ notebook: person.notebook, path: person.path })}>{person.title}</button>
            {person.role && <span className="muted small"> {person.role}</span>}
            <span className="chip small" title="Open tasks">{items.length} open</span>
            {overdue > 0 && <span className="chip small overdue" title="Overdue tasks">{overdue} overdue</span>}
          </li>
        ))}
      </ul>
      {unmatched.length > 0 && (
        <>
          <h2>Owners without a page</h2>
          <ul className="people-list plain-list">
            {unmatched.map((u) => (
              <li key={u.owner.toLowerCase()}>
                <span>{u.owner}</span>
                <span className="chip small" title="Open tasks">{u.items.length} open</span>
                <button type="button" onClick={() => void create(u.owner)}>Create</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating && <NewPerson location={location} onClose={() => setCreating(false)} />}
    </div>
  );
}
