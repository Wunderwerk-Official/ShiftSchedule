// Anthropic model options for the AI agent solver, with list prices used for
// the cost overview in the solver history. Prices are USD per million tokens
// (input / output), as published on platform.claude.com — last checked
// 2026-07. Update here when Anthropic changes pricing.

export type AgentModelOption = {
  id: string;
  label: string;
  description: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Rough cost of one planning run — ballpark for the picker; the exact
   * per-run cost is computed from real token counts in the solver history. */
  approxRunCost: string;
};

export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Balanced quality & cost (default)",
    inputPerMTok: 3,
    outputPerMTok: 15,
    approxRunCost: "≈ $0.50–1.50 per run",
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Best quality",
    inputPerMTok: 5,
    outputPerMTok: 25,
    approxRunCost: "≈ $1–3 per run",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Fastest, lowest cost",
    inputPerMTok: 1,
    outputPerMTok: 5,
    approxRunCost: "≈ $0.10–0.50 per run",
  },
];

export const DEFAULT_AGENT_MODEL = AGENT_MODEL_OPTIONS[0].id;

export type AgentTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Estimated run cost in USD, or null when the model's pricing is unknown.
 * Cache reads bill at ~0.1x and cache writes at 1.25x the input rate. */
export function estimateAgentCostUSD(
  model: string | null | undefined,
  usage: AgentTokenUsage | null | undefined,
): number | null {
  if (!usage) return null;
  const option = AGENT_MODEL_OPTIONS.find((o) => o.id === model);
  if (!option) return null;
  const perTokIn = option.inputPerMTok / 1_000_000;
  const perTokOut = option.outputPerMTok / 1_000_000;
  return (
    (usage.input_tokens ?? 0) * perTokIn +
    (usage.cache_read_input_tokens ?? 0) * perTokIn * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * perTokIn * 1.25 +
    (usage.output_tokens ?? 0) * perTokOut
  );
}

/** "$0.42" for normal amounts, "<$0.01" for dust, null-safe. */
export function formatCostUSD(cost: number | null): string | null {
  if (cost === null) return null;
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}
