import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { agentPlanQuery, agentWikiQuery, invalidateWiki, wikiQuery } = await import("./useWiki");

describe("wiki queries", () => {
  it("a registry change refetches both editions", async () => {
    const client = new QueryClient();
    const keys = [wikiQuery("demo", false).queryKey, agentWikiQuery("demo", "").queryKey, agentWikiQuery("demo", "core").queryKey, ["projects"]];
    for (const k of keys) client.setQueryData(k, 1);
    await invalidateWiki(client);
    expect(keys.map((k) => client.getQueryState(k)!.isInvalidated)).toEqual([true, true, true, false]);
  });

  it("a finished build refetches the agent edition and not the structured one", async () => {
    const client = new QueryClient();
    client.setQueryData(wikiQuery("demo", false).queryKey, 1);
    client.setQueryData(agentWikiQuery("demo", "").queryKey, 1);
    await client.invalidateQueries({ queryKey: ["wiki", "agent"] });
    expect(client.getQueryState(wikiQuery("demo", false).queryKey)!.isInvalidated).toBe(false);
    expect(client.getQueryState(agentWikiQuery("demo", "").queryKey)!.isInvalidated).toBe(true);
  });

  it("a preview is keyed by Restructure, so a superseded one never stands in for the current one", () => {
    const plain = agentPlanQuery("demo", "core", false).queryKey, restructured = agentPlanQuery("demo", "core", true).queryKey;
    expect(plain).not.toEqual(restructured);
    expect(agentPlanQuery("demo", "core", false).queryKey).toEqual(plain);
    expect(agentPlanQuery("demo", "", false).queryKey).not.toEqual(plain);
  });
});
