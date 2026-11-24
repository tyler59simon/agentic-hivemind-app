# People

Stakeholders are Markdown pages, one per person, in a folder of a folder notebook. Task owners link to those pages. The design is CON-15 of the consolidation plan.

## Where People lives

Notes > People sets it up: pick a folder notebook and a folder name (default `People`). Hivemind records the choice in that notebook's sidecar, `.hivemind/notebook.json`:

```json
{ "people": { "folder": "People" } }
```

The People notebook is the first registered folder notebook whose sidecar has a `people` key. Saving the setting on one notebook removes the key from any other, so there is one People location. The folder name is cleaned like the daily notes folder: backslashes become `/`, outer slashes and spaces go, and an empty name means `People`. Rust keeps the key as it keeps any unknown sidecar key.

## What a person page holds

Any Markdown page in the folder is a person. The index reads three properties from its frontmatter:

- `aliases`: other names the person goes by (a list, or one string).
- `role`: shown in the People list.
- `email`: kept for a future Send action (see `executive-workspace.md`).

## How an owner matches a page

An owner is the plain text of a task's `(owner: Dana Lee)` tail. It is not a link. Hivemind trims it and compares it to page titles, file names and aliases, ignoring case. A page's title is its first heading, or its file name when it has none. A title or file name match wins. Otherwise the first page, in title order, that lists the owner in `aliases` matches.

An owner chip on Home and in the Tasks view is a button:

- With a matching page, it opens the page.
- With no page and People set up, it asks "Create a page for Dana Lee in People?" and, on yes, creates the page and opens it.
- With People not set up, it opens Notes > People.

## What creating a page writes

The page goes to `<folder>/<name>.md`. Characters Windows refuses in a file name (`\ / : * ? " < > |`) become `-`, and the name is trimmed. The text is:

```markdown
---
role:
email:
aliases: []
---
# Dana Lee
```

When the file name had to change, `aliases` holds the original name, for example `aliases: ["R/D Lab"]`, so the owner still matches. If a page with that file name exists, it is opened and not changed.

## Where people show up

- Notes > People lists each person with their role, open task count and overdue count, a New person button, and the owners that have no page, each with a Create button.
- The rail of a person's page has an "Open items" section above Backlinks. It lists the open tasks that name the person, with the due date and the page or note each is in. Ticking stays in Home and Tasks.
