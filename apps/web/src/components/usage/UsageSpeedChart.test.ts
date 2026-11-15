import { describe, expect, it } from "vite-plus/test";
import type { ModelSpeed } from "@t3tools/shared/usageMerge";
import {
  buildSpeedRows,
  formatSpeedValue,
  speedAxis,
  speedBaseline,
  speedValues,
  TURN_PERCENTILES,
  turnPercentile,
} from "./UsageSpeedChart.logic";

function model(overrides: Partial<ModelSpeed> = {}): ModelSpeed {
  return {
    provider: "codex",
    model: "gpt-6.1-sol",
    tier: "standard",
    outputTokens: 1000,
    generationMs: 10_000,
    byPeriod: new Map(),
    byHourOfDay: [],
    turnDurationsMs: Array.from({ length: 11 }, (_, i) => (i + 1) * 1000),
    ...overrides,
  };
}

describe("model speed", () => {
  it("filters strictly above ten completed turns and preserves tiers beyond the color palette", () => {
    const input = Array.from({ length: 9 }, (_, i) =>
      model({
        model: i < 6 ? `model-${i}` : "gpt-6.1-sol",
        tier: i === 7 ? "fast" : i === 8 ? "ultrafast" : "standard",
        turnDurationsMs: Array.from({ length: 11 + i }, () => 1000),
      }),
    );
    const { turnDurationsMs: _timings, ...legacy } = model({ model: "legacy" });
    const rows = buildSpeedRows([
      ...input,
      model({ model: "ten", turnDurationsMs: Array(10).fill(1000) }),
      legacy,
    ]);
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.turns)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(9);
    expect(rows.slice(0, 3).map((row) => row.label)).toEqual([
      "gpt-6.1-sol (ultrafast)",
      "gpt-6.1-sol (fast)",
      "gpt-6.1-sol",
    ]);
    expect(rows.every((row) => Boolean(row.color))).toBe(true);
  });

  it("interpolates every percentile and uses the same baseline in both display modes", () => {
    const rows = buildSpeedRows([
      model(),
      model({
        model: "faster",
        outputTokens: 2000,
        turnDurationsMs: Array.from({ length: 11 }, (_, i) => (i + 1) * 500),
      }),
    ]);
    const baseline = speedBaseline(rows)!;
    const faster = rows.find((row) => row.label === "faster")!;
    expect(baseline.label).toBe("gpt-6.1-sol");
    for (const percentile of TURN_PERCENTILES) {
      const expectedMs = (1 + percentile / 10) * 500;
      expect(turnPercentile(faster, percentile)).toBeCloseTo(expectedMs);
      for (const display of ["relative", "absolute"] as const) {
        const result = speedValues(faster, baseline, display, percentile);
        expect(result.output).toBe(display === "relative" ? 200 : 5000);
        expect(result.finish).toBeCloseTo(display === "relative" ? 200 : expectedMs);
        expect(speedValues(baseline, baseline, "relative", percentile)).toEqual({
          output: 100,
          finish: 100,
        });
        expect(speedAxis(result.finish!, display)).toBeGreaterThanOrEqual(result.finish!);
      }
    }
  });

  it("keeps missing throughput and zero-duration percentiles finite without inventing rates", () => {
    const rows = buildSpeedRows([
      model(),
      model({ model: "untimed", generationMs: 0, turnDurationsMs: Array(11).fill(0) }),
    ]);
    const missing = rows.find((row) => row.label === "untimed")!;
    const baseline = speedBaseline(rows)!;
    expect(speedValues(missing, baseline, "relative", 50)).toEqual({ output: null, finish: null });
    expect(speedValues(missing, baseline, "absolute", 50)).toEqual({ output: null, finish: 0 });
    expect(formatSpeedValue(null, "relative")).toBe("n/a");
    expect(formatSpeedValue(1250, "absolute")).toBe("1.3s");
    expect(formatSpeedValue(120_000, "absolute")).toBe("2m 00s");
    expect(formatSpeedValue(150, "relative")).toBe("150%");
  });
});
