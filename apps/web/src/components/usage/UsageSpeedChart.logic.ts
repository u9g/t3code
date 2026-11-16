import { tokensPerSecond, type ModelSpeed } from "@t3tools/shared/usageMerge";

export const TURN_PERCENTILES = [50, 75, 90, 95, 99] as const;
export type TurnPercentile = (typeof TURN_PERCENTILES)[number];
export type SpeedDisplay = "relative" | "absolute";
export type SpeedSortColumn = "model" | "turns" | "output" | "finish";
export interface SpeedSort {
  readonly column: SpeedSortColumn;
  readonly direction: "ascending" | "descending";
}

const COLORS = [
  "light-dark(#2a78d6, #3987e5)",
  "light-dark(#eb6834, #d95926)",
  "light-dark(#1baf7a, #199e70)",
  "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)",
  "light-dark(#6250d6, #9085e9)",
] as const;

export interface SpeedRow {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly turns: number;
  readonly rate: number | null;
  readonly durationsMs: readonly number[];
}

export function buildSpeedRows(speed: readonly ModelSpeed[]): readonly SpeedRow[] {
  return speed
    .flatMap((model, index) => {
      const durationsMs = model.turnDurationsMs;
      if (durationsMs === undefined || durationsMs.length <= 10) return [];
      return [
        {
          key: `${model.provider} ${model.model} ${model.tier}`,
          label: model.tier === "standard" ? model.model : `${model.model} (${model.tier})`,
          color: COLORS[index % COLORS.length]!,
          turns: durationsMs.length,
          rate: tokensPerSecond(model),
          durationsMs: durationsMs.toSorted((a, b) => a - b),
        },
      ];
    })
    .toSorted((a, b) => b.turns - a.turns || a.key.localeCompare(b.key));
}

/** Samples stay unrounded until display, including interpolation between adjacent durations. */
export function turnPercentile(row: SpeedRow, percentile: TurnPercentile): number {
  const position = ((row.durationsMs.length - 1) * percentile) / 100;
  const lower = Math.floor(position);
  const start = row.durationsMs[lower]!;
  return start + (row.durationsMs[Math.ceil(position)]! - start) * (position - lower);
}

export function speedBaseline(rows: readonly SpeedRow[]): SpeedRow | undefined {
  const ranked = rows.toSorted((a, b) => b.turns - a.turns || a.key.localeCompare(b.key));
  return ranked.find((row) => row.rate !== null && row.rate > 0) ?? ranked[0];
}

export function nextSpeedSort(
  current: SpeedSort,
  column: SpeedSortColumn,
  display: SpeedDisplay,
): SpeedSort {
  return {
    column,
    direction:
      current.column === column
        ? current.direction === "ascending"
          ? "descending"
          : "ascending"
        : column === "model" ||
            (display === "absolute" && (column === "output" || column === "finish"))
          ? "ascending"
          : "descending",
  };
}

export function sortSpeedRows(
  rows: readonly SpeedRow[],
  sort: SpeedSort,
  display: SpeedDisplay,
  percentile: TurnPercentile,
): readonly SpeedRow[] {
  const baseline = speedBaseline(rows);
  if (baseline === undefined) return rows;
  const value = (row: SpeedRow) =>
    sort.column === "model"
      ? row.label
      : sort.column === "turns"
        ? row.turns
        : speedValues(row, baseline, display, percentile)[sort.column];
  return rows.toSorted((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null) return right === null ? a.key.localeCompare(b.key) : 1;
    if (right === null) return -1;
    const order =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : Number(left) - Number(right);
    return (sort.direction === "ascending" ? order : -order) || a.key.localeCompare(b.key);
  });
}

export function speedValues(
  row: SpeedRow,
  baseline: SpeedRow,
  display: SpeedDisplay,
  percentile: TurnPercentile,
) {
  const finishMs = turnPercentile(row, percentile);
  if (display === "absolute") {
    return {
      output: row.rate !== null && row.rate > 0 ? 1_000_000 / row.rate : null,
      finish: finishMs,
    };
  }
  const baselineMs = turnPercentile(baseline, percentile);
  return {
    output:
      row.rate !== null && baseline.rate !== null && baseline.rate > 0
        ? (row.rate / baseline.rate) * 100
        : null,
    finish: finishMs > 0 && baselineMs > 0 ? (baselineMs / finishMs) * 100 : null,
  };
}

export function speedAxis(maximum: number, display: SpeedDisplay): number {
  if (display === "relative") return Math.max(100, Math.ceil(maximum / 50) * 50);
  const seconds = maximum / 1000;
  return (
    ([
      5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 300, 600, 900, 1200, 1800, 2400, 3600, 7200, 14400,
      28800, 86400,
    ].find((value) => value >= seconds) ?? seconds) * 1000
  );
}

export function formatSpeedValue(value: number | null, display: SpeedDisplay): string {
  if (value === null) return "n/a";
  if (display === "relative") return `${Math.round(value)}%`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
