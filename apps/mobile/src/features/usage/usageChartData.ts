import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { PROVIDER_ORDER } from "./usageProviders";

/** A turn is one prompt the user sent. */
export type UsageChartMetric = "cost" | "tokens" | "turns";

/** Scheduled turns stack above the providers in a neutral gray. */
export const SCHEDULED_COLOR = "#9ca3af";
/** Delegated turns stack above scheduled ones in a darker gray. */
export const DELEGATED_COLOR = "#6b7280";

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  /** Turns scheduled tasks sent; on the turns metric they leave the provider values. */
  readonly scheduled: number;
  /** Turns another thread's agent sent; on the turns metric they leave the provider values. */
  readonly delegated: number;
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
              : Math.max(0, entry.prompts - entry.scheduledPrompts - entry.delegatedPrompts);
      return { provider, value };
    });
    const acrossProviders = (kind: "scheduledPrompts" | "delegatedPrompts") =>
      metric === "turns"
        ? PROVIDER_ORDER.reduce(
            (sum, provider) => sum + (totals?.byProvider.get(provider)?.[kind] ?? 0),
            0,
          )
        : 0;
    const scheduled = acrossProviders("scheduledPrompts");
    const delegated = acrossProviders("delegatedPrompts");
    return {
      day,
      values,
      scheduled,
      delegated,
      total: values.reduce((sum, entry) => sum + entry.value, scheduled + delegated),
    };
  });
}
