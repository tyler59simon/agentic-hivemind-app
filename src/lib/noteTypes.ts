// Note type definitions: Living Memory's own types and the ones a store defines (`types`).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNoteTypesEnabled } from "./connection";
import { BUILTIN_TYPES, isBuiltinType, noteTypes, type NoteTypeDef } from "./lm";
import { builtinDef } from "./note";

/** The badge colour class: each built-in type has its own, every custom type shares one. */
export const typeClass = (type: string) => `type-${isBuiltinType(type) ? type : "custom"}`;

const BUILTIN_DEFS = BUILTIN_TYPES.map((t) => builtinDef(t));

export interface NoteTypes {
  /** Every type, retired custom types included. */
  all: NoteTypeDef[];
  /** The types a new note or a type change may use. */
  active: NoteTypeDef[];
  def: (name: string) => NoteTypeDef | undefined;
}

/** Note types from Living Memory's `types` (retired ones included), or the built-ins when it has no such command.
 *  `probe` asks even without a connection store (the quick capture window) and falls back to the built-ins on failure. */
export function useNoteTypes(probe = false): NoteTypes {
  const enabled = useNoteTypesEnabled() || probe;
  const q = useQuery({ queryKey: ["types"], queryFn: () => noteTypes(true).then((r) => r.types), enabled, ...(probe ? { retry: false } : {}) });
  return useMemo(() => {
    const all = enabled && q.data ? q.data : BUILTIN_DEFS;
    return { all, active: all.filter((t) => t.status === "active"), def: (name: string) => all.find((t) => t.name === name) };
  }, [enabled, q.data]);
}

/** Names for a type picker: the active types, plus the current one when it is retired or not loaded yet. */
export function typeOptions(active: NoteTypeDef[], current?: string): string[] {
  const names = active.map((t) => t.name);
  return current && !names.includes(current) ? [...names, current] : names;
}
