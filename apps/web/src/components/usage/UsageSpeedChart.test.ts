import { describe, expect, it } from "vite-plus/test";
import type { ModelSpeed } from "@t3tools/shared/usageMerge";
import {
  buildSpeedRows,
  formatSpeedValue,
  nextSpeedSort,
  sortSpeedRows,
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
      model({ model: "baseline" }),
      model({
        model: "faster",
        outputTokens: 2000,
        turnDurationsMs: Array.from({ length: 11 }, (_, i) => (i + 1) * 500),
      }),
    ]);
    const baseline = speedBaseline(rows)!;
    const faster = rows.find((row) => row.label === "faster")!;
    expect(baseline.label).toBe("baseline");
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
      }
    }
  });

  it("sorts every column in both directions using displayed values and keeps n/a last", () => {
    const rows = buildSpeedRows([
      model({ model: "charlie", turnDurationsMs: Array(13).fill(2000) }),
      model({
        model: "alpha",
        outputTokens: 2000,
        turnDurationsMs: [...Array(11).fill(4000), 9000],
      }),
      model({
        model: "bravo",
        outputTokens: 500,
        turnDurationsMs: [...Array(10).fill(1000), 10_000],
      }),
      model({ model: "missing", generationMs: 0, turnDurationsMs: Array(14).fill(3000) }),
    ]);
    const ascending = {
      model: ["alpha", "bravo", "charlie", "missing"],
      turns: ["bravo", "alpha", "charlie", "missing"],
      output: ["alpha", "charlie", "bravo"],
      finish: ["bravo", "charlie", "missing", "alpha"],
    };
    for (const display of ["absolute", "relative"] as const) {
      for (const percentile of [50, 99] as const) {
        for (const column of ["model", "turns", "output", "finish"] as const) {
          for (const direction of ["ascending", "descending"] as const) {
            let expected =
              column === "finish" && percentile === 99
                ? ["charlie", "missing", "alpha", "bravo"]
                : ascending[column];
            if (display === "relative" && (column === "output" || column === "finish"))
              expected = expected.toReversed();
            if (direction === "descending") expected = expected.toReversed();
            if (column === "output") expected = [...expected, "missing"];
            const sorted = sortSpeedRows(rows, { column, direction }, display, percentile);
            expect(
              sorted.map((row) => row.label),
              `${display} ${percentile} ${column} ${direction}`,
            ).toEqual(expected);
            expect(speedBaseline(sorted)?.label).toBe("charlie");
          }
        }
      }
    }
  });

  it("toggles the active column and starts new sorts in a useful direction", () => {
    for (const display of ["absolute", "relative"] as const) {
      for (const column of ["model", "turns", "output", "finish"] as const) {
        const direction =
          column === "model" || (display === "absolute" && column !== "turns")
            ? "ascending"
            : "descending";
        const selected = nextSpeedSort(
          { column: column === "model" ? "turns" : "model", direction: "ascending" },
          column,
          display,
        );
        expect(selected).toEqual({ column, direction });
        const reversed = nextSpeedSort(selected, column, display);
        expect(reversed.direction).toBe(direction === "ascending" ? "descending" : "ascending");
        expect(nextSpeedSort(reversed, column, display)).toEqual(selected);
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
    const untimed = buildSpeedRows([
      model({ model: "most-used", generationMs: 0, turnDurationsMs: Array(12).fill(1000) }),
      model({ model: "other", generationMs: 0 }),
    ]);
    expect(
      speedBaseline(
        sortSpeedRows(untimed, { column: "turns", direction: "ascending" }, "relative", 50),
      )?.label,
    ).toBe("most-used");
  });
});
