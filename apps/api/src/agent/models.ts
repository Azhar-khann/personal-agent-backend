/**
 * The models the agent may run on. Prices are USD per million tokens, from
 * OpenAI's pricing page on 2026-09-17 — update when they change.
 */
export const MODELS: Record<string, { reasoning: boolean; input: number; cachedInput: number; output: number }> = {
  "gpt-5.6-luna": { reasoning: true, input: 0.2, cachedInput: 0.02, output: 1.2 },
  // Not a reasoning model: the API rejects a reasoning effort for it.
  "gpt-4.1-mini": { reasoning: false, input: 0.4, cachedInput: 0.1, output: 1.6 },
};

export type TokenUsage = {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  /** The part of the input served from OpenAI's prompt cache, billed at the cached rate. */
  cachedInputTokens: number;
  outputTokens: number;
};

/** A model id as served may carry a dated suffix ("gpt-4.1-mini-2025-04-14"). */
function modelInfo(model: string) {
  const key = Object.keys(MODELS).find((id) => model === id || model.startsWith(`${id}-`));
  return key ? MODELS[key] : undefined;
}

/** Whether to send a reasoning effort. Assumed for a model not listed here. */
export const usesReasoning = (model: string) => modelInfo(model)?.reasoning ?? true;

export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = modelInfo(model);
  if (!price) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncached * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) / 1_000_000
  );
}
