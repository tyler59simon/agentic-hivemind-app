import { CodeEditor } from "./CodeEditor";

export interface EditorProps {
  doc: string;
  docVersion: number;               // bump to replace the document (after save, merge or an outside change)
  live: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  titles: () => string[];
  onOpenLink: (target: string, split: boolean) => void;
  reveal?: { line: number; at: number } | null;
}

/** The note editor: Markdown, wrapped lines, no line numbers. */
export function MarkdownEditor(props: EditorProps) {
  return <CodeEditor {...props} language="markdown" readOnly={false} lineNumbers={false} placeholder="Write the summary first…" />;
}
