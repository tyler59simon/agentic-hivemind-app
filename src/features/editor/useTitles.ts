import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { domains, list } from "../../lib/lm";

/** Titles a [[link]] written in this domain can reach: the domain's own notes plus the global domains'. */
export function useTitles(domain: string | null | undefined) {
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const notes = useQuery({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }) });
  const latest = useRef<string[]>([]);
  const reach = new Set([domain, ...(known.data?.global_domains ?? ["_global"])]);
  latest.current = [...new Set((notes.data?.notes ?? []).filter((n) => reach.has(n.domain)).map((n) => n.title))].sort();
  return useCallback(() => latest.current, []);
}
