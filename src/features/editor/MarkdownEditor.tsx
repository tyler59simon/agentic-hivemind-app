import { CodeEditor } from "./CodeEditor";

export interface EditorProps {
  doc: string;
  docVersion: number;               // bump to replace the document (after save, merge or an outside change)
  /** Take every change of `doc` made elsewhere, not only version bumps: another pane editing the same note. */
  follow?: boolean;
  live: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  titles: () => string[];
  onOpenLink: (target: string, split: boolean) => void;
  reveal?: { line: number; at: number } | null;
  /** The text can be read and selected but not changed. */
  readOnly?: boolean;
}

/** The note editor: Markdown, wrapped lines, no line numbers. */
export function MarkdownEditor(props: EditorProps) {
  return <CodeEditor {...props} language="markdown" readOnly={props.readOnly ?? false} lineNumbers={false} placeholder="Write the summary first…" />;
}
