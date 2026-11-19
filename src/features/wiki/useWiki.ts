// The wiki model of one domain. Every key of the wiki starts with "wiki" and then names its edition ("structured" or "agent"), so a
// domain called "agent" cannot collide with an edition prefix; refreshStore (note changes) refetches them and `invalidateWiki`
// reaches them all.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAgentWikiEnabled, useWikiEnabled } from "../../lib/connection";
import { agentWikiModel, wikiModel } from "../../lib/lm";
import { wikiAgentBuild } from "../../lib/wiki";
import { indexModel } from "./wiki";

/** Refetch the structured and the agent-written edition (a registry change moves the projects and folders of both). */
export const invalidateWiki = (client: QueryClient) => client.invalidateQueries({ queryKey: ["wiki"] });

export const wikiQuery = (domain: string, archived: boolean) => ({ queryKey: ["wiki", "structured", domain, archived], queryFn: () => wikiModel(domain, { archived }) });

/** The domain's wiki, indexed; `ix` is null while loading, with no domain, or when this Living Memory has no `wiki` command.
 *  Switching `archived` (not the domain) keeps the previous model on screen until the new one arrives. */
export function useWiki(domain: string | null, archived: boolean) {
  const enabled = useWikiEnabled();
  const query = useQuery({ ...wikiQuery(domain ?? "", archived), enabled: enabled && !!domain, placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === domain ? prev : undefined) });
  const ix = useMemo(() => (query.data ? indexModel(query.data) : null), [query.data]);
  return { enabled, query, ix };
}

/** The saved agent-written edition of a domain (`project` "" for the whole domain). Its `data` is null when none was built yet,
 *  which the page shows as an empty state, not an error. `on` is false while the structured edition is shown. */
export const agentWikiQuery = (domain: string, project: string) => ({ queryKey: ["wiki", "agent", domain, project], queryFn: () => agentWikiModel(domain, project || undefined) });

/** What a build would do (a dry run, which spends nothing). The key holds everything the plan depends on, Restructure included, so a
 *  preview that was superseded by a toggle is a different query and never shows in place of the current one. */
export const agentPlanQuery = (domain: string, project: string, restructure: boolean) => ({
  queryKey: ["wiki-agent-plan", domain, project, restructure], retry: false, staleTime: 0, gcTime: 0,
  queryFn: () => wikiAgentBuild(domain, project || undefined, restructure, true),
});
export function useAgentWiki(domain: string | null, project: string, on: boolean) {
  const enabled = useAgentWikiEnabled();
  const query = useQuery({ ...agentWikiQuery(domain ?? "", project), enabled: enabled && on && !!domain });
  const ix = useMemo(() => (query.data ? indexModel(query.data) : null), [query.data]);
  return { enabled, query, ix };
}
