import { describe, expect, it } from "vitest";
import { budgetLevel, budgetMessage, formatTokens, usagePollMs, usageText, USAGE_POLL_MS, type Usage } from "./usage";

const usage = (over: Partial<Usage> = {}): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, costExact: false, limits: null, ...over });
const win = (usedPercent: number, windowMinutes: number) => ({ usedPercent, windowMinutes, resetsAt: 0 });

describe("usage text", () => {
  it("formats token counts", () => {
    expect([950, 1000, 12_400, 999_999, 1_200_000].map(formatTokens)).toEqual(["950", "1k", "12.4k", "1M", "1.2M"]);
  });

  it("shows tokens and an exact or estimated cost", () => {
    expect(usageText(usage({ inputTokens: 10_000, outputTokens: 2400, costUsd: 0.31, costExact: true }))).toBe("12.4k tokens · $0.31");
    expect(usageText(usage({ inputTokens: 10_000, outputTokens: 2400, costUsd: 0.31 }))).toBe("12.4k tokens · ≈ $0.31");
    expect(usageText(usage({ inputTokens: 500, costUsd: 0.001 }))).toBe("500 tokens · ≈ <$0.01");
    expect(usageText(usage({ inputTokens: 500 }))).toBe("500 tokens");
    expect(usageText(usage())).toBe("");
    expect(usageText(undefined)).toBe("");
  });

  it("names the fuller Codex window", () => {
    const limits = { primary: win(3, 300), secondary: win(28, 10080) };
    expect(usageText(usage({ inputTokens: 40_000, outputTokens: 1900, limits }))).toBe("41.9k tokens · 28% of weekly limit");
    expect(usageText(usage({ inputTokens: 2, limits: { primary: win(60, 300), secondary: win(28, 10080) } }))).toBe("2 tokens · 60% of 5-hour limit");
    expect(usageText(usage({ limits: { primary: win(10, 120), secondary: null } }))).toBe("10% of 2-hour limit");
  });

  it("polls only while the session runs", () => {
    expect(usagePollMs(true)).toBe(USAGE_POLL_MS);
    expect(usagePollMs(false)).toBe(false);
  });
});

describe("budget level", () => {
  it("warns from 80% and goes over at 100% of the budget for Claude", () => {
    expect(budgetLevel("claude", usage({ costUsd: 3.99 }), 5)).toBe("none");
    expect(budgetLevel("claude", usage({ costUsd: 4 }), 5)).toBe("warn");
    expect(budgetLevel("claude", usage({ costUsd: 5 }), 5)).toBe("over");
    expect(budgetLevel("claude", usage({ costUsd: null }), 5)).toBe("none");
    expect(budgetLevel("claude", undefined, 5)).toBe("none");
  });

  it("uses the fuller plan window for Codex and ignores cost", () => {
    const at = (a: number, b: number) => usage({ costUsd: 99, limits: { primary: win(a, 300), secondary: win(b, 10080) } });
    expect(budgetLevel("codex", at(10, 79), 5)).toBe("none");
    expect(budgetLevel("codex", at(10, 82), 5)).toBe("warn");
    expect(budgetLevel("codex", at(100, 82), 5)).toBe("over");
    expect(budgetLevel("codex", usage(), 5)).toBe("none");
  });

  it("words the banners", () => {
    expect(budgetMessage("claude", usage({ costUsd: 4.2 }), 5, "warn")).toBe("This session has used $4.20 of your $5.00 budget.");
    expect(budgetMessage("claude", usage({ costUsd: 5.1 }), 5, "over")).toBe("This session is over your $5.00 budget. Hivemind does not stop it.");
    const limits = { primary: win(0, 300), secondary: win(82.4, 10080) };
    expect(budgetMessage("codex", usage({ limits }), 5, "warn")).toBe("Codex has used 82% of your weekly limit.");
    expect(budgetMessage("codex", usage({ limits: { primary: null, secondary: win(100, 10080) } }), 5, "over")).toBe("Codex has reached your weekly limit.");
  });
});
