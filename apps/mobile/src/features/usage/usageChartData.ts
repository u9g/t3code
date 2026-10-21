import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { PROVIDER_ORDER } from "./usageProviders";

/** A turn is one prompt the user sent. */
export type UsageChartMetric = "cost" | "tokens" | "turns";

/** Scheduled turns stack above the providers in a neutral gray. */
export const SCHEDULED_COLOR = "#9ca3af";

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  /** Turns scheduled tasks sent; on the turns metric they leave the provider values. */
  readonly scheduled: number;
  readonly total: number;
}

export function buildChartDays(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
): readonly UsageChartDay[] {
  const byDay = new Map(daily.map((totals) => [totals.day, totals]));
  return days.map((day) => {
    const totals = byDay.get(day);
    const values = PROVIDER_ORDER.map((provider) => {
      const entry = totals?.byProvider.get(provider);
      const value =
        entry === undefined
          ? 0
          : metric === "cost"
            ? entry.costUsd
            : metric === "tokens"
              ? entry.totalTokens
              : Math.max(0, entry.prompts - entry.scheduledPrompts);
      return { provider, value };
    });
    const scheduled =
      metric === "turns"
        ? PROVIDER_ORDER.reduce(
            (sum, provider) => sum + (totals?.byProvider.get(provider)?.scheduledPrompts ?? 0),
            0,
          )
        : 0;
    return {
      day,
      values,
      scheduled,
      total: values.reduce((sum, entry) => sum + entry.value, scheduled),
    };
  });
}
