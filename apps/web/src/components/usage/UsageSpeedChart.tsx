import { useState } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";

import { tokensPerSecond, type ModelSpeed, type SpeedTotals } from "@t3tools/shared/usageMerge";
import { formatDayShort, formatHourShort, formatTokens } from "@t3tools/shared/usageFormat";
import {
  VIEW_HEIGHT,
  VIEW_WIDTH,
  curvePath,
  niceScale,
  smoothCurve,
  valueToY,
  type Point,
} from "./UsageProviderChart";

// Validated categorical slots (light, dark), assigned in this fixed order by output volume.
const SERIES_COLORS = [
  "light-dark(#2a78d6, #3987e5)",
  "light-dark(#eb6834, #d95926)",
  "light-dark(#1baf7a, #199e70)",
  "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)",
  "light-dark(#6250d6, #9085e9)",
] as const;

/** Points with less timed output than this are too noisy to plot. */
const MIN_SPEED_SAMPLE_TOKENS = 500;

const HOURS_OF_DAY = Array.from({ length: 24 }, (_, hour) => hour);

interface SpeedSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly overall: number | null;
  /** Tokens per second per x position, or null where there is too little data. */
  readonly values: readonly (number | null)[];
}

function sampleRate(totals: SpeedTotals | undefined): number | null {
  return totals === undefined || totals.outputTokens < MIN_SPEED_SAMPLE_TOKENS
    ? null
    : tokensPerSecond(totals);
}

function buildSpeedSeries(
  speed: readonly ModelSpeed[],
  pick: (model: ModelSpeed) => readonly (SpeedTotals | undefined)[],
): readonly SpeedSeries[] {
  return speed.slice(0, SERIES_COLORS.length).map((model, index) => ({
    key: `${model.provider} ${model.model}`,
    label: model.model,
    color: SERIES_COLORS[index]!,
    overall: tokensPerSecond(model),
    values: pick(model).map(sampleRate),
  }));
}

/** Consecutive runs of plotted points, so a gap in the data is a gap in the line. */
function runs(
  values: readonly (number | null)[],
  toPoint: (index: number, value: number) => Point,
) {
  const result: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) result.push(current);
      current = [];
    } else current.push(toPoint(index, value));
  });
  if (current.length > 0) result.push(current);
  return result;
}

const formatRate = (value: number) => `${value >= 100 ? Math.round(value) : value.toFixed(1)}`;

function SpeedChart({
  title,
  series,
  xLabels,
  formatX,
}: {
  readonly title: string;
  readonly series: readonly SpeedSeries[];
  readonly xLabels: readonly string[];
  readonly formatX: (index: number) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const count = xLabels.length;
  const peak = series.reduce(
    (max, entry) => entry.values.reduce<number>((inner, value) => Math.max(inner, value ?? 0), max),
    0,
  );
  const scale = niceScale(peak, 4);
  const stepX = count < 2 ? 0 : VIEW_WIDTH / (count - 1);
  const toY = (value: number) => valueToY(value, scale.max);
  const hovered =
    hoverIndex === null
      ? []
      : series
          .map((entry) => ({ entry, value: entry.values[hoverIndex] ?? null }))
          .filter((row): row is { entry: SpeedSeries; value: number } => row.value !== null)
          .toSorted((a, b) => b.value - a.value);
  const hoverFraction = hoverIndex === null || count < 2 ? 0 : hoverIndex / (count - 1);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : `${formatRate(tick)}/s`}
            </span>
          ))}
        </div>
        <div
          className="relative h-56 flex-1"
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (bounds.width === 0 || count === 0) return;
            const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
            setHoverIndex(Math.round(fraction * (count - 1)));
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${title}, output tokens per second by model`}
          >
            {scale.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((entry) =>
              runs(entry.values, (index, value) => ({ x: index * stepX, y: toY(value) })).map(
                (points) =>
                  points.length === 1 ? (
                    <line
                      key={`${entry.key}-${points[0]!.x}`}
                      x1={points[0]!.x}
                      x2={points[0]!.x}
                      y1={points[0]!.y}
                      y2={points[0]!.y}
                      stroke={entry.color}
                      strokeWidth={6}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : (
                    <path
                      key={`${entry.key}-${points[0]!.x}`}
                      d={curvePath(smoothCurve(points))}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  ),
              ),
            )}
            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={0}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hoverIndex === null ? null : (
            <div
              className="surface-glass pointer-events-none absolute top-0 z-10 min-w-44 rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={
                hoverFraction > 0.6
                  ? { right: `calc(${(1 - hoverFraction) * 100}% + 12px)` }
                  : { left: `calc(${hoverFraction * 100}% + 12px)` }
              }
            >
              <div className="mb-1 text-muted-foreground">{formatX(hoverIndex)}</div>
              {hovered.length === 0 ? (
                <div className="text-muted-foreground">Not enough timed output</div>
              ) : (
                hovered.map(({ entry, value }) => (
                  <div key={entry.key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: entry.color }}
                      />
                      <span className="truncate">{entry.label}</span>
                    </span>
                    <span className="text-foreground tabular-nums">{formatRate(value)} tok/s</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        <span>{count > 0 ? xLabels[0] : ""}</span>
        <span>{count > 0 ? xLabels[Math.floor(count / 2)] : ""}</span>
        <span>{count > 0 ? xLabels[count - 1] : ""}</span>
      </div>
    </section>
  );
}

export function UsageSpeedSection({
  speed,
  periods,
  resolution,
  timeZone,
  hour12,
}: {
  readonly speed: readonly ModelSpeed[];
  readonly periods: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly hour12: boolean;
}) {
  // Empty shows every model; otherwise only the picked ones, keeping their colors.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  if (speed.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No timed responses in this period. Speed is measured from Claude and Codex transcripts.
      </p>
    );
  }

  const byHourOfDay = buildSpeedSeries(speed, (model) => model.byHourOfDay);
  const byPeriod = buildSpeedSeries(speed, (model) =>
    periods.map((period) => model.byPeriod.get(period)),
  );
  const formatHourOfDay = (hour: number) =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", hour12 }).format(
      new Date(2000, 0, 1, hour),
    );
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone, hour12) : formatDayShort(period);
  const periodLabels = periods.map(formatPeriod);
  const hourLabels = HOURS_OF_DAY.map(formatHourOfDay);
  const shown = (series: readonly SpeedSeries[]) =>
    picked.size === 0 ? series : series.filter((entry) => picked.has(entry.key));
  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label="Models">
        {byHourOfDay.map((entry, index) => {
          const active = picked.size === 0 || picked.has(entry.key);
          return (
            <li key={entry.key}>
              <button
                type="button"
                aria-pressed={picked.has(entry.key)}
                onClick={() => toggle(entry.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 transition-opacity hover:bg-accent",
                  picked.has(entry.key) && "bg-accent",
                  !active && "opacity-45",
                )}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
                <span className="text-foreground">{entry.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {entry.overall === null ? "n/a" : `${formatRate(entry.overall)} tok/s`} ·{" "}
                  {formatTokens(speed[index]?.outputTokens ?? 0)} out
                </span>
              </button>
            </li>
          );
        })}
        {picked.size === 0 ? null : (
          <li className="px-2">
            <InlineButton tone="muted" onClick={() => setPicked(new Set())}>
              Show all
            </InlineButton>
          </li>
        )}
      </ul>
      <SpeedChart
        title="Output speed by time of day"
        series={shown(byHourOfDay)}
        xLabels={hourLabels}
        formatX={(index) => hourLabels[index] ?? ""}
      />
      <SpeedChart
        title={resolution === "hour" ? "Output speed by hour" : "Output speed by day"}
        series={shown(byPeriod)}
        xLabels={periodLabels}
        formatX={(index) => periodLabels[index] ?? ""}
      />
      <p className="text-xs text-muted-foreground">
        Output tokens (including reasoning) over the time from a request&apos;s input to its last
        output, so time to first token counts. Points with under{" "}
        {formatTokens(MIN_SPEED_SAMPLE_TOKENS)} timed output tokens are left out
        {speed.length > SERIES_COLORS.length
          ? `; showing the ${SERIES_COLORS.length} models with the most output`
          : ""}
        .
      </p>
    </div>
  );
}
