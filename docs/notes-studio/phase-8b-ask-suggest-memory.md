# NS-8B: Ask a notebook, suggestions and save to memory

Read [phase-8a-ai-actions.md](phase-8a-ai-actions.md) and [phase-4b-semantic.md](phase-4b-semantic.md) first.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Ask and suggestions retrieve without `--include-private` and without private notebooks from Hivemind's index, whatever notebook the user picked; Save to memory checks the source page's notebook in Rust before it calls Executive Capture (S10).
- Round 2: local retrieval and Save to memory use the same effective policy as NS-8A (S10).

## 1. What the user sees

- **Ask** panel on the Notes page: a chat scoped to the current notebook by default, with chips to add other notebooks and Living Memory (domains). Answers cite sources as numbered chips; clicking one opens the page and highlights the exact paragraph. "I could not find this in the notebook" is a valid answer. Private notebooks cannot be added.
- **Suggestions** rail section on a page: suggested links (pages and memory notes that mention this page's key terms or are semantically close), suggested tags (from tags used in the notebook), related memory notes, and a suggested title for untitled pages. Each has Accept or Dismiss; accepting inserts the link or tag in the page.
- **Save to memory**: on a selection or a whole page, sends the text to Executive Capture, which extracts decisions, risks, commitments and knowledge for review as today; each accepted memory note gets a link back to the page, and the page rail lists **Memory made from this page**.

## 2. Design

- Ask retrieval: lexical and semantic hits from the Hivemind index (blocks with anchors) plus `alm search` and `alm ask` for chosen domains; at most 12 passages and 12,000 characters, each labelled with an id; the model must answer in a schema `{ answer, citations: [{ id, quote }] }`; Rust checks every cited id was sent and every quote appears in its passage (dropping citations that fail).
- Retrieved text is data, never instructions: the policy says so and passages are fenced.
- Suggestions are local first: links, tags and related notes come from the index and semantic search at no cost; the model is used only for a title, at most once per page per 10 minutes after a meaningful change, and only while the day's spend is under 25% of the cap.
- Save to memory: `exec_extract` gains `Source { kind: "page", label, ref }`; `items.ts itemBody` adds a link line to the page (a `file:` or `doc:` reference rendered as a Hivemind link). Hivemind keeps the reverse map (page docKey to memory refs) in `app_data/provenance.json`; Living Memory `sources:` is not used for this, because source digests go stale whenever the page changes.

## 3. Tests and exit

cargo: retrieval limits, citation validation (missing id, quote not in passage), suggestions budget gate, provenance file. vitest: citation chip mapping to anchors, suggestion acceptance edits. Exit: citations open the exact paragraph; provenance shows both ways; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
