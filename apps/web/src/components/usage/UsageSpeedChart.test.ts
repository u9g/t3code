import { describe, expect, it } from "vite-plus/test";
import type { ModelSpeed } from "@t3tools/shared/usageMerge";

import { buildSpeedSeries } from "./UsageSpeedChart";

describe("buildSpeedSeries", () => {
  it("keeps lower-volume tiers visible beyond the color palette", () => {
    const speed: ModelSpeed[] = Array.from({ length: 9 }, (_, index) => ({
      provider: "codex",
      model: index < 6 ? `model-${index}` : "gpt-6.1-sol",
      tier: index === 7 ? "fast" : index === 8 ? "ultrafast" : "standard",
      outputTokens: 9000 - index * 1000,
      generationMs: 1000,
      byPeriod: new Map(),
      byHourOfDay: [],
    }));
    const series = buildSpeedSeries(speed, (model) => [model]);

    expect(series).toHaveLength(speed.length);
    expect(new Set(series.map((entry) => entry.key)).size).toBe(speed.length);
    expect(series.slice(6).map((entry) => entry.label)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol (fast)",
      "gpt-6.1-sol (ultrafast)",
    ]);
    for (const [index, entry] of series.entries()) {
      expect(entry.color).toBeTruthy();
      expect(entry.values).toEqual([speed[index]!.outputTokens]);
    }
  });
});
