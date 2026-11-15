import { useState } from "react";
import type { ModelSpeed } from "@t3tools/shared/usageMerge";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  buildSpeedRows,
  formatSpeedValue,
  speedAxis,
  speedBaseline,
  speedValues,
  TURN_PERCENTILES,
  type SpeedDisplay,
  type TurnPercentile,
} from "./UsageSpeedChart.logic";

function SpeedBar({
  value,
  maximum,
  color,
  display,
}: {
  readonly value: number | null;
  readonly maximum: number;
  readonly color: string;
  readonly display: SpeedDisplay;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-4 min-w-0 flex-1" aria-hidden>
        {value === null ? null : (
          <div
            className="h-full rounded-sm transition-[width] duration-150 motion-reduce:transition-none"
            style={{ width: `${(value / maximum) * 100}%`, backgroundColor: color }}
          />
        )}
        {display === "relative" ? (
          <div
            className="absolute -top-0.5 h-5 w-px bg-muted-foreground/35"
            style={{ left: `${(100 / maximum) * 100}%` }}
          />
        ) : null}
      </div>
      <span className="w-18 shrink-0 text-right tabular-nums">
        {formatSpeedValue(value, display)}
      </span>
    </div>
  );
}

function SpeedTicks({
  maximum,
  display,
}: {
  readonly maximum: number;
  readonly display: SpeedDisplay;
}) {
  return (
    <div
      className="flex items-center gap-3 pt-3 text-3xs text-muted-foreground tabular-nums"
      aria-hidden
    >
      <div className="flex min-w-0 flex-1 justify-between">
        {[0, 0.5, 1].map((fraction) => (
          <span key={fraction}>
            {display === "relative"
              ? `${fraction * maximum}%`
              : maximum * fraction >= 60_000
                ? `${(maximum * fraction) / 60_000}m`
                : `${(maximum * fraction) / 1000}s`}
          </span>
        ))}
      </div>
      <span className="w-18 shrink-0" />
    </div>
  );
}

export function UsageSpeedSection({ speed }: { readonly speed: readonly ModelSpeed[] }) {
  const [display, setDisplay] = useState<SpeedDisplay>("relative");
  const [percentile, setPercentile] = useState<TurnPercentile>(50);
  const rows = buildSpeedRows(speed);
  const baseline = speedBaseline(rows);
  const values =
    baseline === undefined
      ? []
      : rows.map((row) => ({ row, ...speedValues(row, baseline, display, percentile) }));
  const outputMaximum = speedAxis(
    Math.max(0, ...values.map((value) => value.output ?? 0)),
    display,
  );
  const finishMaximum = speedAxis(
    Math.max(0, ...values.map((value) => value.finish ?? 0)),
    display,
  );
  const relativeLabel = `${baseline?.label ?? "Baseline"} = 100% · higher is faster`;

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
          <table className="w-full min-w-160 table-fixed text-xs">
            <colgroup>
              <col className="w-[23%]" />
              <col className="w-[8%]" />
              <col className="w-[34.5%]" />
              <col className="w-[34.5%]" />
            </colgroup>
            <thead>
              <tr className="align-top text-left font-normal">
                <th scope="col" className="pb-4 pe-4 font-normal">
                  Model / tier
                  <span className="mt-1.5 block text-3xs text-muted-foreground">
                    Most completed turns first
                  </span>
                </th>
                <th scope="col" className="pb-4 pe-5 text-right font-normal">
                  Turns ↓<span className="mt-1.5 block text-3xs text-muted-foreground">Total</span>
                </th>
                <th scope="col" className="pb-4 pe-5 font-normal">
                  Output speed
                  <span className="mt-1.5 block text-3xs text-muted-foreground">
                    {display === "relative"
                      ? relativeLabel
                      : "Time / 1,000 tokens · lower is faster"}
                  </span>
                </th>
                <th scope="col" className="pb-4 font-normal">
                  <div className="flex items-center gap-1">
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
                    <span>turn finish time</span>
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
                <tr key={row.key}>
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
                  <td className="py-3 pe-5">
                    <SpeedBar
                      value={output}
                      maximum={outputMaximum}
                      color={row.color}
                      display={display}
                    />
                  </td>
                  <td className="py-3">
                    <SpeedBar
                      value={finish}
                      maximum={finishMaximum}
                      color={row.color}
                      display={display}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td />
                <td className="pe-5">
                  <SpeedTicks maximum={outputMaximum} display={display} />
                </td>
                <td>
                  <SpeedTicks maximum={finishMaximum} display={display} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
