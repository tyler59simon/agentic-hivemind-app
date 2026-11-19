// The wiki model of one domain. The key starts with "wiki", so refreshStore (note changes) refetches it.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAgentWikiEnabled, useWikiEnabled } from "../../lib/connection";
import { agentWikiModel, wikiModel } from "../../lib/lm";
import { indexModel } from "./wiki";

export const wikiQuery = (domain: string, archived: boolean) => ({ queryKey: ["wiki", domain, archived], queryFn: () => wikiModel(domain, { archived }) });

/** The domain's wiki, indexed; `ix` is null while loading, with no domain, or when this Living Memory has no `wiki` command.
 *  Switching `archived` (not the domain) keeps the previous model on screen until the new one arrives. */
export function useWiki(domain: string | null, archived: boolean) {
  const enabled = useWikiEnabled();
  const query = useQuery({ ...wikiQuery(domain ?? "", archived), enabled: enabled && !!domain, placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === domain ? prev : undefined) });
  const ix = useMemo(() => (query.data ? indexModel(query.data) : null), [query.data]);
  return { enabled, query, ix };
}

/** The saved agent-written edition of a domain (`project` "" for the whole domain). Its `data` is null when none was built yet,
 *  which the page shows as an empty state, not an error. `on` is false while the structured edition is shown. */
export const agentWikiQuery = (domain: string, project: string) => ({ queryKey: ["wiki-agent", domain, project], queryFn: () => agentWikiModel(domain, project || undefined) });
export function useAgentWiki(domain: string | null, project: string, on: boolean) {
  const enabled = useAgentWikiEnabled();
  const query = useQuery({ ...agentWikiQuery(domain ?? "", project), enabled: enabled && on && !!domain });
  const ix = useMemo(() => (query.data ? indexModel(query.data) : null), [query.data]);
  return { enabled, query, ix };
}
