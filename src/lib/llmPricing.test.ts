import { describe, expect, it } from "vitest";
import { AGENT_MODEL_OPTIONS, DEFAULT_AGENT_MODEL, estimateAgentCostUSD, formatCostUSD } from "./llmPricing";

const MILLION = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
};

describe("AGENT_MODEL_OPTIONS", () => {
  it("offers Opus 5.5 first, as the default (arena round 8)", () => {
    expect(DEFAULT_AGENT_MODEL).toBe("claude-opus-5-5");
    expect(AGENT_MODEL_OPTIONS.filter((o) => o.description.includes("(default)")).map((o) => o.id))
      .toEqual(["claude-opus-5-5"]);
  });

  it("lists Anthropic's list prices per million tokens (input / output)", () => {
    const prices = Object.fromEntries(
      AGENT_MODEL_OPTIONS.map((o) => [o.id, [o.inputPerMTok, o.outputPerMTok]]),
    );
    expect(prices).toEqual({
      "claude-sonnet-5": [2, 10],
      "claude-opus-5-5": [4, 20],
      "claude-opus-4-8": [5, 25],
      "claude-haiku-4-5": [1, 5],
    });
  });
});

describe("estimateAgentCostUSD", () => {
  it("bills cache reads at 0.1x and cache writes at 1.25x the input rate", () => {
    // Sonnet 5: 2 in + 10 out + 0.2 cache read + 2.5 cache write
    expect(estimateAgentCostUSD("claude-sonnet-5", MILLION)).toBeCloseTo(14.7);
    expect(estimateAgentCostUSD("claude-opus-4-8", MILLION)).toBeCloseTo(36.75);
  });

  it("bills Opus 5.5 cache reads at 0.05x ($0.20 per MTok)", () => {
    // 4 in + 20 out + 0.2 cache read + 5 cache write
    expect(estimateAgentCostUSD("claude-opus-5-5", MILLION)).toBeCloseTo(29.2);
  });

  it("returns null for unknown models or missing usage", () => {
    expect(estimateAgentCostUSD("unknown-model", MILLION)).toBeNull();
    expect(estimateAgentCostUSD("claude-sonnet-5", null)).toBeNull();
  });
});

describe("formatCostUSD", () => {
  it("formats cents, dust and null", () => {
    expect(formatCostUSD(14.7)).toBe("$14.70");
    expect(formatCostUSD(0.004)).toBe("<$0.01");
    expect(formatCostUSD(null)).toBeNull();
  });
});
