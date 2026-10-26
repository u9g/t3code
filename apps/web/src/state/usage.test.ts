import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeAnsweredUsage } from "./usage";

const day = "2026-08-07" as UsageDay;

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-07T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: day,
  untilDay: day,
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
  scanDurationMs: 1,
  scheduledPrompts: [{ day, provider: "claude", model: "claude-opus-5-5", count: 2 }],
  delegatedPrompts: [
    { day, provider: "codex", model: "gpt-6-sol", count: 3 },
    { day, provider: "claude", model: "claude-opus-5-5", count: 1 },
  ],
};

describe("mergeAnsweredUsage", () => {
  it("keeps only the server prompts of the kept models", () => {
    const merged = mergeAnsweredUsage(
      [
        {
          environmentId: "mac" as EnvironmentId,
          label: "mac",
          isPending: false,
          canReadDiagnostics: true,
          isConnected: true,
          error: null,
          summary,
          needsCursorKeychainAccess: false,
        },
      ],
      (entry) => entry.provider === "codex" && entry.model === "gpt-6-sol",
    );
    expect(merged.delegatedPrompts).toBe(3);
    expect(merged.scheduledPrompts).toBe(0);
  });
});
