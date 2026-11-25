// The automated accessibility check for the component tests (DESK-A11Y). `expectNoNewAxeViolations` runs axe-core over a
// rendered tree and compares what it finds with a baseline kept in the test, so a new violation fails the test and so does a
// baseline entry that no longer occurs (the list shrinks as fixes land and cannot go stale).
//
// axe sorts what it finds into violations and "needs review" results (it cannot decide). Both are checked: a needs-review
// result is a real problem in several cases here (an aria-label on an element without a role is ignored by screen readers, but axe
// cannot be sure when the element has text). Baseline entries for those start with "review:".
import axe from "axe-core";

export interface AxeViolation {
  /** "review" for a result axe could not decide. */
  kind: "violation" | "review";
  id: string;
  impact: string | null;
  /** The CSS selector axe gives for the node. An iframe or shadow root path is joined with " >> ". */
  target: string;
  help: string;
}

/** Rules that need a real layout or real painting, which jsdom does not have, so axe cannot judge them here:
 *  - color-contrast: needs computed colors over rendered backgrounds, and the tests load no CSS.
 *  - target-size (WCAG 2.2 AA 2.5.8): needs element rectangles; jsdom reports every box as 0 x 0.
 *  - scrollable-region-focusable: needs scroll sizes, which are 0 in jsdom.
 *  - region: asks that all content sit in a landmark. Component tests render a part of the page, so the rule would flag the test
 *    harness. The shell test checks the landmarks of the whole frame with the other landmark rules.
 *  - bypass, page-has-heading-one, landmark-one-main: page-level rules for a document, not for a rendered fragment.
 *  - document-title, html-has-lang, html-lang-valid: facts about index.html, not about components.
 *  - label-content-name-mismatch (WCAG 2.5.3): axe tells an icon font from text by drawing it on a canvas. jsdom has none, so axe
 *    reports an error for the first element it meets and checks no other; `labelNotInName` below makes the same check without it. */
export const JSDOM_DISABLED_RULES = [
  "color-contrast",
  "target-size",
  "scrollable-region-focusable",
  "region",
  "bypass",
  "page-has-heading-one",
  "landmark-one-main",
  "document-title",
  "html-has-lang",
  "html-lang-valid",
  "label-content-name-mismatch",
] as const;

export interface AxeOptions {
  /** More rules to switch off for one test, on top of JSDOM_DISABLED_RULES. */
  disable?: string[];
}

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const LABELLED = "button, a[href], summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], [role=treeitem]";

/** WCAG 2.5.3, Label in Name: a control with an `aria-label` and text on it must have that text in its name. Text that only a
 *  screen reader gets (`.visually-hidden`) and icons are not on the control. */
export function labelNotInName(root: Element): AxeViolation[] {
  const found: AxeViolation[] = [];
  for (const el of root.querySelectorAll(LABELLED)) {
    const label = el.getAttribute("aria-label");
    if (!label) continue;
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(".visually-hidden, svg, img").forEach((n) => n.remove());
    const shown = normal(clone.textContent ?? "");
    if (shown && !normal(label).includes(shown)) {
      found.push({ kind: "violation", id: "label-in-name", impact: "serious", target: `${el.localName}${[...el.classList].map((c) => `.${c}`).join("")}[aria-label="${label}"]`, help: `The name "${label}" does not contain the visible text "${shown}" (WCAG 2.5.3)` });
    }
  }
  return found;
}

/** The violations axe finds in `root`, one entry per failing node. */
export async function axeViolations(root: Element, options: AxeOptions = {}): Promise<AxeViolation[]> {
  const rules: Record<string, { enabled: boolean }> = {};
  for (const id of [...JSDOM_DISABLED_RULES, ...(options.disable ?? [])]) rules[id] = { enabled: false };
  const results = await axe.run(root, { rules, resultTypes: ["violations", "incomplete"] });
  const found: AxeViolation[] = [];
  for (const [kind, list] of [["violation", results.violations], ["review", results.incomplete]] as const) {
    for (const v of list) {
      for (const node of v.nodes) found.push({ kind, id: v.id, impact: v.impact ?? node.impact ?? null, target: node.target.map(String).join(" >> "), help: v.help });
    }
  }
  return [...found, ...labelNotInName(root)];
}

/** A baseline entry is `rule-id` (every node of the rule) or `rule-id @ selector` (one node, as axe prints it), with "review:"
 *  in front for a needs-review result. Prefer the second form: it keeps a fix for one node from hiding a new violation of the
 *  same rule elsewhere. */
const ruleOf = (v: AxeViolation) => (v.kind === "review" ? `review:${v.id}` : v.id);
const keyOf = (v: AxeViolation) => `${ruleOf(v)} @ ${v.target}`;

/** Fails with the new violations (rule, selector, help text) and with the baseline entries that no longer occur. */
export async function expectNoNewAxeViolations(root: Element, baseline: string[], options: AxeOptions = {}): Promise<void> {
  const found = await axeViolations(root, options);
  const covered = (v: AxeViolation) => baseline.includes(keyOf(v)) || baseline.includes(ruleOf(v));
  const fresh = found.filter((v) => !covered(v));
  const gone = baseline.filter((b) => !found.some((v) => b === keyOf(v) || b === ruleOf(v)));
  const lines: string[] = [];
  if (fresh.length) {
    lines.push(`${fresh.length} axe result(s) not in the baseline:`);
    for (const v of fresh) lines.push(`  ${ruleOf(v)} (${v.impact ?? "needs review"}) at ${v.target}\n    ${v.help}\n    baseline entry: "${keyOf(v)}"`);
  }
  if (gone.length) {
    lines.push(`${gone.length} baseline entr${gone.length === 1 ? "y" : "ies"} no longer occur, remove from the baseline:`);
    for (const b of gone) lines.push(`  ${b}`);
  }
  if (lines.length) throw new Error(lines.join("\n"));
}
