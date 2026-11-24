// A task's owner as a button (CON-15): it opens the owner's People page, offers to create it, or, when People is not set up,
// goes to the place that sets it up.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { useApp } from "../../store";
import { Confirm } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { openPage } from "../notes/actions";
import { matchOwner } from "./people";
import { createPerson, usePeople } from "./usePeople";

export function OwnerChip({ owner }: { owner: string }) {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const { location, people } = usePeople();
  const [asking, setAsking] = useState(false);
  const person = matchOwner(people, owner);
  const click = () => {
    if (person) openPage({ notebook: person.notebook, path: person.path });
    else if (location) setAsking(true);
    else go({ page: "notes", view: "people" });
  };
  const title = person ? `Open ${person.title}'s page` : location ? "No page for this owner yet" : "Set up People to link owners to pages";
  return (
    <>
      <button type="button" className="chip small owner-chip" title={title} onClick={click}>{owner}</button>
      {asking && location && (
        <Confirm title="Create a page?" action="Create page" message={<p>Create a page for <b>{owner}</b> in {location.folder}?</p>}
          onAnswer={(yes) => {
            setAsking(false);
            if (yes) createPerson(client, location, owner).catch((e) => toast(classify(e).message, "error"));
          }} />
      )}
    </>
  );
}
