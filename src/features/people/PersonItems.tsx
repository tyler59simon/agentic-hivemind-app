// The "Open items" section of a person's page in the rail (CON-15): the open tasks whose owner names this person. Ticking is
// left to Home and Tasks.
import type { FileRef } from "../../documents/keys";
import { Section } from "../../ui/Page";
import { displayText } from "../notes/tasks";
import { openSource } from "../notes/useTaskItems";
import { useOwnedItems, usePeople } from "./usePeople";

/** Shown only for a page in the People folder, so other pages do not load every open task. */
export function PersonItems({ file }: { file: FileRef }) {
  const { location } = usePeople();
  if (!location || file.notebook !== location.notebook || !file.path.startsWith(`${location.folder}/`)) return null;
  return <OpenItems path={file.path} />;
}

function OpenItems({ path }: { path: string }) {
  const { owned } = useOwnedItems();
  const items = owned.find((o) => o.person.path === path)?.items ?? [];
  return (
    <Section title="Open items" count={items.length} empty={items.length ? undefined : "No open items name this person."}>
      {items.length > 0 && (
        <ul className="plain-list person-items">
          {items.map((t) => (
            <li key={t.id}>
              <span>{displayText(t.text)}</span>
              {t.due && <span className="chip small" title="Due date">{t.due}</span>}
              <button type="button" className="link" onClick={() => openSource(t)}>{t.title || t.path}</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
