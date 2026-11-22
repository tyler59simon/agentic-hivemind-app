// The plan that follows a rename or a move (NS-4A): which links in which pages reach what is about to move, worked out from
// the index and the resolver before the files move, and shown to the user afterwards.
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { movedPath } from "../../documents/keys";
import { isLm } from "../../documents/adapters/lmdoc";
import { indexIncoming } from "../../lib/noteindex";
import { loadEnv } from "./env";
import { planRewrite, type Plan } from "./rewrite";

/** The plan waiting for the user's answer, if any. */
export const useRewritePlan = create<{ plan: Plan | null }>(() => ({ plan: null }));

/** The links in the notebook's pages (and in other notebooks') that reach the page or folder `from`, and what each says once
 *  it is `to`. Null when nothing needs writing, and when the index cannot say: a move never waits for it. */
export async function planFor(client: QueryClient, notebook: string, from: string, to: string): Promise<Plan | null> {
  if (isLm({ notebook })) return null;
  try {
    const env = await loadEnv(client, 0);
    const moved = (env.pagesOf(notebook) ?? []).filter((p) => movedPath(p, from, to) !== null);
    if (!moved.length) return null;
    const incoming = await indexIncoming(moved);
    const plan = planRewrite({ notebook, from, to, moved, incoming, env });
    return plan.pages.length || plan.stuck.length ? plan : null;
  } catch {
    return null;
  }
}
