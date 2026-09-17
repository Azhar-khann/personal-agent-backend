import { describe, expect, it } from "vitest";

import { costUsd, usesReasoning } from "./models.js";

describe("costUsd", () => {
  it("bills cached input at the cached rate", () => {
    // A typical eval message: 2,110 in, 2,066 of them cached, 120 out.
    expect(costUsd("gpt-5.6-luna", { inputTokens: 2110, cachedInputTokens: 2066, outputTokens: 120 })).toBeCloseTo(0.00019412, 8);
  });

  it("knows a model served under a dated id", () => {
    expect(costUsd("gpt-4.1-mini-2025-04-14", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(0.4);
  });

  it("is unknown for a model without a price", () => {
    expect(costUsd("some-other-model", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 })).toBeNull();
  });
});

describe("usesReasoning", () => {
  it("is off for gpt-4.1-mini, which rejects a reasoning effort", () => {
    expect(usesReasoning("gpt-4.1-mini")).toBe(false);
    expect(usesReasoning("gpt-5.6-luna")).toBe(true);
  });
});
