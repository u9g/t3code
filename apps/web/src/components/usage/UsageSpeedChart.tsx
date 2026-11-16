import { useState } from "react";
import type { ModelSpeed } from "@t3tools/shared/usageMerge";

import { InlineButton } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  buildSpeedRows,
  formatSpeedValue,
  nextSpeedSort,
  sortSpeedRows,
  speedBaseline,
  speedValues,
  TURN_PERCENTILES,
  type SpeedDisplay,
  type SpeedSort,
  type SpeedSortColumn,
  type TurnPercentile,
} from "./UsageSpeedChart.logic";

export function UsageSpeedSection({ speed }: { readonly speed: readonly ModelSpeed[] }) {
  const [display, setDisplay] = useState<SpeedDisplay>("absolute");
  const [percentile, setPercentile] = useState<TurnPercentile>(50);
  const [sort, setSort] = useState<SpeedSort>({ column: "turns", direction: "descending" });
  const rows = buildSpeedRows(speed);
  const baseline = speedBaseline(rows);
  const values =
    baseline === undefined
      ? []
      : sortSpeedRows(rows, sort, display, percentile).map((row) => ({
          row,
          ...speedValues(row, baseline, display, percentile),
        }));
  const relativeLabel = `${baseline?.label ?? "Baseline"} = 100% · higher is faster`;

  const sortHeader = (column: SpeedSortColumn, label: string) => (
    <InlineButton onClick={() => setSort((current) => nextSpeedSort(current, column, display))}>
      {label}
      <span aria-hidden>
        {sort.column === column ? (sort.direction === "ascending" ? " ↑" : " ↓") : " ↕"}
      </span>
    </InlineButton>
  );
  const sortDirection = (column: SpeedSortColumn) =>
    sort.column === column ? sort.direction : undefined;

  return (
    <section className="flex flex-col gap-6" aria-label="Model speed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Model speed</h2>
        <ToggleGroup
          aria-label="Speed display"
          variant="segmented"
          value={[display]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "relative" || value === "absolute") setDisplay(value);
          }}
        >
          <Toggle value="relative">Relative %</Toggle>
          <Toggle value="absolute">Absolute time</Toggle>
        </ToggleGroup>
      </div>
      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No models with more than 10 completed turns in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 table-fixed text-xs" aria-label="Model speed">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[12%]" />
              <col className="w-[28%]" />
              <col className="w-[30%]" />
            </colgroup>
            <thead>
              <tr className="align-top text-left font-normal">
                <th
                  scope="col"
                  aria-sort={sortDirection("model")}
                  className="pb-4 pe-4 font-normal"
                >
                  {sortHeader("model", "Model / tier")}
                </th>
                <th
                  scope="col"
                  aria-sort={sortDirection("turns")}
                  className="pb-4 pe-5 text-right font-normal"
                >
                  {sortHeader("turns", "Turns")}
                  <span className="mt-1.5 block text-3xs text-muted-foreground">Total</span>
                </th>
                <th
                  scope="col"
                  aria-sort={sortDirection("output")}
                  className="pb-4 pe-5 text-right font-normal"
                >
                  {sortHeader("output", "Output speed")}
                  <span className="mt-1.5 block text-3xs text-muted-foreground">
                    {display === "relative"
                      ? relativeLabel
                      : "Time / 1,000 tokens · lower is faster"}
                  </span>
                </th>
                <th
                  scope="col"
                  aria-sort={sortDirection("finish")}
                  className="pb-4 text-right font-normal"
                >
                  <div className="flex items-center justify-end gap-1">
                    <Select
                      value={String(percentile)}
                      onValueChange={(value) => {
                        const next = TURN_PERCENTILES.find((entry) => entry === Number(value));
                        if (next !== undefined) setPercentile(next);
                      }}
                    >
                      <SelectTrigger
                        aria-label="Turn finish time percentile"
                        size="compact"
                        className="w-auto min-w-0"
                      >
                        <SelectValue>{`p${percentile}`}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" matchTriggerWidth={false}>
                        {TURN_PERCENTILES.map((value) => (
                          <SelectItem key={value} value={String(value)}>{`p${value}`}</SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {sortHeader("finish", "Turn finish time")}
                  </div>
                  <span className="mt-1.5 block text-3xs text-muted-foreground">
                    {display === "relative"
                      ? relativeLabel
                      : "Submitted → completed · lower is faster"}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {values.map(({ row, output, finish }) => (
                <tr key={row.key} className="border-t border-border">
                  <th scope="row" className="py-3 pe-4 text-left font-normal">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="min-w-0 break-words">{row.label}</span>
                    </div>
                  </th>
                  <td className="py-3 pe-5 text-right text-muted-foreground tabular-nums">
                    {row.turns.toLocaleString()}
                  </td>
                  <td className="py-3 pe-5 text-right tabular-nums">
                    {formatSpeedValue(output, display)}
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {formatSpeedValue(finish, display)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
