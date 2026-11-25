// Notepad++-style editor line bookmarks (Phase 0): gutter markers, line highlight,
// keyboard navigation (Mod+F2, F2, Shift+F2), and Copy/Cut/Delete bookmarked lines.
import { Prec, RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, keymap, type DecorationSet } from "@codemirror/view";

const toggleAtEffect = StateEffect.define<number>();
const clearAllEffect = StateEffect.define<void>();

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bookmark-dot";
    el.title = "Bookmarked line (click to remove)";
    el.textContent = "●";
    return el;
  }
}

const MARKER = new BookmarkMarker();
const LINE_DECO = Decoration.line({ class: "cm-bookmarked-line" });

/** Per-line bookmark positions mapped automatically across document edits. */
export const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearAllEffect)) {
        next = RangeSet.empty;
      } else if (e.is(toggleAtEffect)) {
        const lineFrom = tr.state.doc.lineAt(Math.min(Math.max(0, e.value), tr.state.doc.length)).from;
        let has = false;
        next.between(lineFrom, lineFrom, () => { has = true; });
        if (has) {
          next = next.update({ filter: (from) => from !== lineFrom });
        } else {
          next = next.update({ add: [MARKER.range(lineFrom)], sort: true });
        }
      }
    }
    // Deduplicate markers that collapsed onto the same line start after a multi-line deletion.
    if (tr.docChanged && next.size > 0) {
      const seen = new Set<number>();
      const builder = new RangeSetBuilder<GutterMarker>();
      const iter = next.iter();
      while (iter.value) {
        const from = tr.state.doc.lineAt(iter.from).from;
        if (!seen.has(from)) {
          seen.add(from);
          builder.add(from, from, MARKER);
        }
        iter.next();
      }
      next = builder.finish();
    }
    return next;
  },
});

const bookmarkLineHighlight = EditorView.decorations.from(bookmarkField, (markers): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const iter = markers.iter();
  while (iter.value) {
    builder.add(iter.from, iter.from, LINE_DECO);
    iter.next();
  }
  return builder.finish();
});

/** Return 1-based sorted line numbers that currently have a bookmark. */
export function bookmarkedLineNumbers(state: EditorState): number[] {
  const set = state.field(bookmarkField, false);
  if (!set || set.size === 0) return [];
  const nums: number[] = [];
  const iter = set.iter();
  while (iter.value) {
    nums.push(state.doc.lineAt(iter.from).number);
    iter.next();
  }
  return nums;
}

/** Toggle a bookmark on the line containing document offset `pos`. */
export function toggleBookmarkAt(view: EditorView, pos: number): boolean {
  if (!view.state.field(bookmarkField, false)) return false;
  view.dispatch({ effects: toggleAtEffect.of(pos) });
  return true;
}

/** Toggle bookmarks on every active cursor's line (Mod+F2). */
export function toggleBookmark(view: EditorView): boolean {
  if (!view.state.field(bookmarkField, false)) return false;
  const seen = new Set<number>();
  const effects: StateEffect<number>[] = [];
  for (const r of view.state.selection.ranges) {
    const from = view.state.doc.lineAt(r.head).from;
    if (!seen.has(from)) {
      seen.add(from);
      effects.push(toggleAtEffect.of(from));
    }
  }
  if (!effects.length) return false;
  view.dispatch({ effects });
  return true;
}

/** Jump to the next bookmarked line after the cursor, wrapping around to the first (F2). */
export function nextBookmark(view: EditorView): boolean {
  const nums = bookmarkedLineNumbers(view.state);
  if (!nums.length) return false;
  const curLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const target = nums.find((n) => n > curLine) ?? nums[0];
  const from = view.state.doc.line(target).from;
  view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  return true;
}

/** Jump to the previous bookmarked line before the cursor, wrapping around to the last (Shift+F2). */
export function prevBookmark(view: EditorView): boolean {
  const nums = bookmarkedLineNumbers(view.state);
  if (!nums.length) return false;
  const curLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const earlier = nums.filter((n) => n < curLine);
  const target = earlier.length ? earlier[earlier.length - 1] : nums[nums.length - 1];
  const from = view.state.doc.line(target).from;
  view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  return true;
}

/** Remove all bookmarks in the editor. */
export function clearBookmarks(view: EditorView): boolean {
  const set = view.state.field(bookmarkField, false);
  if (!set || set.size === 0) return false;
  view.dispatch({ effects: clearAllEffect.of() });
  return true;
}

/** Return the text of all bookmarked lines joined by `\n`, or null when no lines are bookmarked. */
export function bookmarkedLinesText(state: EditorState): string | null {
  const nums = bookmarkedLineNumbers(state);
  if (!nums.length) return null;
  return nums.map((n) => state.doc.line(n).text).join("\n");
}

/** Delete all bookmarked lines in a single undoable transaction. Returns the number of deleted lines. */
export function deleteBookmarkedLines(view: EditorView): number {
  if (view.state.readOnly) return 0;
  const nums = bookmarkedLineNumbers(view.state);
  if (!nums.length) return 0;
  const doc = view.state.doc;
  const totalLines = doc.lines;
  const changes: { from: number; to: number }[] = [];
  for (let i = 0; i < nums.length; i++) {
    const line = doc.line(nums[i]);
    if (line.number < totalLines) {
      changes.push({ from: line.from, to: line.to + 1 });
    } else if (line.from > 0) {
      // Removing the final line also consumes the preceding newline unless that line is already being removed.
      const prevDeleted = i > 0 && nums[i - 1] === line.number - 1;
      changes.push({ from: prevDeleted ? line.from : line.from - 1, to: line.to });
    } else {
      changes.push({ from: 0, to: line.to });
    }
  }
  view.dispatch({ changes, effects: clearAllEffect.of() });
  return nums.length;
}

const bookmarkGutter = gutter({
  class: "cm-bookmark-gutter",
  markers: (view) => view.state.field(bookmarkField),
  initialSpacer: () => MARKER,
  domEventHandlers: {
    mousedown(view, line) {
      toggleBookmarkAt(view, line.from);
      return true;
    },
  },
});

/** Bookmark state, gutter, line highlight, and Mod+F2 / F2 / Shift+F2 bindings for file tabs. */
export function bookmarkExtensions(): Extension {
  return [
    bookmarkField,
    bookmarkLineHighlight,
    bookmarkGutter,
    Prec.high(keymap.of([
      { key: "Mod-F2", run: toggleBookmark, preventDefault: true },
      { key: "F2", run: nextBookmark, preventDefault: true },
      { key: "Shift-F2", run: prevBookmark, preventDefault: true },
    ])),
  ];
}
