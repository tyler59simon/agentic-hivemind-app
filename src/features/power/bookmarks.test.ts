// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  bookmarkedLineNumbers, bookmarkedLinesText, bookmarkExtensions, clearBookmarks,
  deleteBookmarkedLines, nextBookmark, prevBookmark, toggleBookmark, toggleBookmarkAt,
} from "./bookmarks";

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

function makeView(doc: string) {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [history(), bookmarkExtensions()] }),
  });
  return view;
}

describe("CodeMirror line bookmarks (Phase 0)", () => {
  it("toggles, navigates forward/backward with wrap, copies text, and clears bookmarks", () => {
    const v = makeView("alpha\nbeta\ngamma\ndelta");
    // Bookmark line 2 and line 4.
    toggleBookmarkAt(v, v.state.doc.line(2).from);
    toggleBookmarkAt(v, v.state.doc.line(4).from);
    expect(bookmarkedLineNumbers(v.state)).toEqual([2, 4]);
    expect(bookmarkedLinesText(v.state)).toBe("beta\ndelta");

    // Cursor on line 1 -> next jumps to 2, then 4, then wraps to 2.
    v.dispatch({ selection: { anchor: 0 } });
    expect(nextBookmark(v)).toBe(true);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(2);
    expect(nextBookmark(v)).toBe(true);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(4);
    expect(nextBookmark(v)).toBe(true);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(2);

    // Previous wraps back to line 4.
    expect(prevBookmark(v)).toBe(true);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(4);

    // Toggling on line 4 removes that bookmark.
    toggleBookmark(v);
    expect(bookmarkedLineNumbers(v.state)).toEqual([2]);

    clearBookmarks(v);
    expect(bookmarkedLineNumbers(v.state)).toEqual([]);
    expect(nextBookmark(v)).toBe(false);
  });

  it("deletes all bookmarked lines (including final line) in one undoable transaction", () => {
    const v = makeView("one\ntwo\nthree\nfour");
    toggleBookmarkAt(v, v.state.doc.line(2).from);
    toggleBookmarkAt(v, v.state.doc.line(4).from);
    expect(deleteBookmarkedLines(v)).toBe(2);
    expect(v.state.doc.toString()).toBe("one\nthree");
    expect(bookmarkedLineNumbers(v.state)).toEqual([]);

    undo(v);
    expect(v.state.doc.toString()).toBe("one\ntwo\nthree\nfour");
  });
});
