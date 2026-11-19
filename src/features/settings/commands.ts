// The per-project list of commands agent sessions may run without asking, as the Settings form edits it: one command per line.

/** The commands in a textarea: one per line, trimmed, without blanks or repeats. */
export function commandsFromText(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

/** A project's list with `text` as its commands; a project with none is left out. */
export function withCommands(all: Record<string, string[]> | null | undefined, project: string, text: string): Record<string, string[]> {
  const next = { ...(all ?? {}) };
  const commands = commandsFromText(text);
  if (commands.length) next[project] = commands; else delete next[project];
  return next;
}
