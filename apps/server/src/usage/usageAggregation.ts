// @effect-diagnostics globalDate:off
import type {
  UsageBucket,
  UsageCategoryCost,
  UsageDay,
  UsageGenerationTiming,
  UsageModelFilter,
  UsageModelSelector,
  UsageProviderKind,
  UsageResolution,
  UsageServerPromptKind,
  UsageServerPrompts,
  UsageTokenTotals,
  UsageTurnTimings,
} from "@t3tools/contracts";

import {
  EMPTY_TOTALS,
  type UsageRecord,
  type UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import { cacheSavingsUsd, lookupRate, priceUsage, type RateTable } from "./usagePricing.ts";

// en-CA gives ISO-ordered parts in the requested zone; Date getters are host-local.
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Cache quarter-hour slots to avoid per-record Intl calls; fixed-offset midnight can split slots and needs exact formatting.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

// Zone offsets are whole quarter hours, so one local hour covers each quarter-hour slot.
function makeHourOfDayFormatter(timeZone: string): (timestampMs: number) => number {
  const options = { hour: "numeric", hourCycle: "h23" } as const;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  const hours = new Map<number, number>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let hour = hours.get(slot);
    if (hour === undefined) {
      hour = Number(format.format(new Date(slot * QUARTER_HOUR_MS))) % 24;
      hours.set(slot, hour);
    }
    return hour;
  };
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface MutableBucket {
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  records: number;
  prompts: number;
  /** Keyed by service tier, then indexed by local hour of day; created on the first timed response. */
  speed: Map<UsageSpeed, { outputTokens: number; generationMs: number }[]> | null;
  unpricedRecords: number;
  unpricedTokens: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly rateModel?: (provider: UsageRecord["provider"], model: string) => string | undefined;
  readonly modelFilter?: UsageModelFilter;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
}

export function usageTimestampFilter(
  options: Pick<
    AggregateOptions,
    "timeZone" | "sinceDay" | "untilDay" | "sinceTimeMs" | "untilTimeMs"
  >,
) {
  const toDay = makeDayFormatter(options.timeZone);
  return (timestampMs: number) => {
    if (options.sinceTimeMs !== undefined && options.untilTimeMs !== undefined) {
      return timestampMs >= options.sinceTimeMs && timestampMs < options.untilTimeMs;
    }
    const day = toDay(timestampMs);
    return day >= options.sinceDay && day <= options.untilDay;
  };
}

export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const models = Object.keys(aliases);
  const memo = new Map<string, string | null>();
  for (const model of models) {
    if (memo.has(model)) continue;
    const path: string[] = [];
    let target = model;
    while (Object.hasOwn(aliases, target) && !memo.has(target)) {
      path.push(target);
      // Null marks both the active walk and paths that end in a cycle.
      memo.set(target, null);
      target = aliases[target]!;
    }
    const terminal = Object.hasOwn(aliases, target) ? (memo.get(target) ?? null) : target;
    for (const alias of path) memo.set(alias, terminal);
  }

  const resolved = new Map<string, string>();
  for (const model of models) {
    const target = memo.get(model);
    if (target !== null && target !== undefined) resolved.set(model, target);
  }
  return resolved;
}

/** Matches original IDs, so an alias cannot pull excluded usage into a kept model. */
function keepsUsageRecord(
  filter: UsageModelFilter | undefined,
  record: Pick<UsageRecord, "model" | "provider">,
): boolean {
  if (filter === undefined) return true;
  const model = record.model.trim();
  const matches = (selector: UsageModelSelector) =>
    selector.model === model &&
    (selector.provider === undefined || selector.provider === record.provider);
  return (filter.include?.some(matches) ?? true) && !(filter.exclude?.some(matches) ?? false);
}

const selectorKey = (selector: UsageModelSelector) =>
  JSON.stringify([selector.provider ?? null, selector.model]);

const canonicalSelectors = (selectors: readonly UsageModelSelector[]) =>
  [...new Map(selectors.map((selector) => [selectorKey(selector), selector]))]
    // Code-unit order, so servers in different locales echo the same form.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, selector]) => selector);

/** Equal filters get one form, so they share scans and clients can compare echoed filters. */
export function canonicalModelFilter(
  filter: UsageModelFilter | undefined,
): UsageModelFilter | undefined {
  if (filter === undefined) return undefined;
  const exclude = filter.exclude?.length ? canonicalSelectors(filter.exclude) : undefined;
  if (filter.include === undefined && exclude === undefined) return undefined;
  return {
    ...(filter.include === undefined ? {} : { include: canonicalSelectors(filter.include) }),
    ...(exclude === undefined ? {} : { exclude }),
  };
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly turnTimings: readonly UsageTurnTimings[];
  readonly generationTimings: readonly UsageGenerationTiming[];
  /** Only the kinds with at least one prompt in the window. */
  readonly serverPrompts: Partial<Record<UsageServerPromptKind, readonly UsageServerPrompts[]>>;
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

/**
 * Partial copies share a billed message's key: keep each token channel's maximum and the larger
 * reported cost, and the first copy's time, model, session and speed so it stays in its bucket.
 */
export function mergeUsageCopies(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.max(held.reportedCostUsd, copy.reportedCostUsd);
  const heldModelCalls = held.modelCalls ?? 0;
  const copyModelCalls = copy.modelCalls ?? 0;
  const modelCalls = Math.max(heldModelCalls, copyModelCalls);
  if (
    b.uncachedInputTokens <= a.uncachedInputTokens &&
    b.cachedInputTokens <= a.cachedInputTokens &&
    b.cacheCreationTokens <= a.cacheCreationTokens &&
    b.outputTokens <= a.outputTokens &&
    b.reasoningTokens <= a.reasoningTokens &&
    (copy.cacheCreation1hTokens ?? 0) <= (held.cacheCreation1hTokens ?? 0) &&
    copyModelCalls <= heldModelCalls &&
    reportedCostUsd === held.reportedCostUsd &&
    (copy.generationMs ?? 0) <= (held.generationMs ?? 0)
  ) {
    return held;
  }
  const cacheCreation1hTokens = Math.max(
    held.cacheCreation1hTokens ?? 0,
    copy.cacheCreation1hTokens ?? 0,
  );
  const generationMs =
    held.generationMs === undefined || copy.generationMs === undefined
      ? (held.generationMs ?? copy.generationMs)
      : Math.max(held.generationMs, copy.generationMs);
  return {
    ...held,
    ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
    ...(modelCalls > 1 ? { modelCalls } : {}),
    ...(generationMs === undefined ? {} : { generationMs }),
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}

/**
 * Grok reports each turn once, complete, so real copies are equal. A larger one is a deleted
 * transcript's pre-v17 maximum over turns that shared a prompt id, whichever source it came from.
 */
function smallestGrokCopy(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const generationMs =
    a.outputTokens === b.outputTokens
      ? (held.generationMs ?? copy.generationMs)
      : a.outputTokens < b.outputTokens
        ? held.generationMs
        : copy.generationMs;
  const { generationMs: _untimed, ...base } = held;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.min(held.reportedCostUsd, copy.reportedCostUsd);
  const modelCalls =
    held.modelCalls !== undefined && copy.modelCalls !== undefined
      ? Math.min(held.modelCalls, copy.modelCalls)
      : (held.modelCalls ?? copy.modelCalls);
  return {
    ...base,
    ...(modelCalls !== undefined && modelCalls > 1 ? { modelCalls } : {}),
    ...(generationMs === undefined ? {} : { generationMs }),
    totals: {
      uncachedInputTokens: Math.min(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.min(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.min(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.min(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.min(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}

interface Contribution {
  record: UsageRecord;
  /** Null when the first copy fell outside the window. */
  readonly bucket: MutableBucket | null;
}

/** Deduplicates across the whole scan; Claude copies records into resumed/forked transcripts. */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #serverPrompts = new Map<UsageServerPromptKind, Map<string, number>>();
  readonly #generationTimings = new Map<string, UsageGenerationTiming>();
  readonly #turnTimings = new Map<
    string,
    { provider: UsageProviderKind; model: string; tier: UsageSpeed; durationsMs: number[] }
  >();
  readonly #seen = new Map<string, Contribution>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #toHourOfDay: (timestampMs: number) => number;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #lastBucket: {
    readonly day: string;
    readonly hourIndex: number;
    readonly provider: string;
    readonly model: string;
    readonly source: string;
    readonly bucket: MutableBucket;
  } | null = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
    this.#toHourOfDay = makeHourOfDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs,
      };
    } else {
      this.#hourlyWindow = null;
    }
  }

  add(input: UsageRecord, sourcePath?: string): boolean {
    if (!keepsUsageRecord(this.#options.modelFilter, input)) return false;
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      const held = this.#seen.get(record.dedupeKey);
      if (held !== undefined) {
        this.#duplicatesDropped += 1;
        if (held.bucket !== null) {
          held.record =
            record.provider === "grok"
              ? smallestGrokCopy(held.record, record)
              : mergeUsageCopies(held.record, record);
        }
        return false;
      }
    }

    const bucket = this.#placeInWindow(record, sourcePath ?? "");
    if (record.dedupeKey !== null) this.#seen.set(record.dedupeKey, { record, bucket });
    if (bucket === null) {
      this.#outOfWindow += 1;
      return false;
    }
    // Keyed usage is counted in finish(), once all its copies are merged.
    if (record.dedupeKey === null) this.#accumulate(bucket, record);
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  #placeInWindow(record: UsageRecord, source: string): MutableBucket | null {
    const slot = this.#slotFor(record.timestampMs);
    if (slot === null) return null;
    return this.#bucketFor(slot.day, slot.hourIndex, record.provider, record.model, source);
  }

  #accumulate(bucket: MutableBucket, record: UsageRecord): void {
    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);

    const totals = bucket.totals;
    totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    totals.cachedInputTokens += record.totals.cachedInputTokens;
    totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    totals.outputTokens += record.totals.outputTokens;
    totals.reasoningTokens += record.totals.reasoningTokens;
    bucket.costUsd += priced.costUsd;
    if (priced.categoryCostUsd !== null) {
      const sum = bucket.categoryCostUsd;
      const add = priced.categoryCostUsd;
      bucket.categoryCostUsd =
        sum === null
          ? add
          : {
              input: sum.input + add.input,
              cacheRead: sum.cacheRead + add.cacheRead,
              cacheWrite: sum.cacheWrite + add.cacheWrite,
              output: sum.output + add.output,
            };
    }
    if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
    bucket.speedPremiumUsd += priced.speedPremiumUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      record,
      this.#options.priceOverrides,
    );
    bucket.records += 1;
    bucket.prompts += record.prompts ?? 0;
    if (record.generationMs !== undefined && record.totals.outputTokens > 0) {
      bucket.speed ??= new Map();
      let hours = bucket.speed.get(record.speed);
      if (hours === undefined) {
        hours = Array.from({ length: 24 }, () => ({ outputTokens: 0, generationMs: 0 }));
        bucket.speed.set(record.speed, hours);
      }
      const sample = hours[this.#toHourOfDay(record.timestampMs)]!;
      sample.outputTokens += record.totals.outputTokens;
      sample.generationMs += record.generationMs;
    }
    if (priced.costSource === "unpriced") {
      bucket.unpricedRecords += 1;
      bucket.unpricedTokens +=
        record.totals.uncachedInputTokens +
        record.totals.cachedInputTokens +
        record.totals.cacheCreationTokens +
        record.totals.outputTokens;
    }
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
  }

  addGenerationUsage(
    timestampMs: number,
    provider: UsageProviderKind,
    model: string,
    tier: UsageSpeed,
    outputTokens: number,
    generationMs: number,
  ): void {
    const slot = this.#slotFor(timestampMs);
    if (
      slot === null ||
      !Number.isFinite(generationMs) ||
      generationMs <= 0 ||
      !Number.isFinite(outputTokens) ||
      outputTokens <= 0 ||
      !keepsUsageRecord(this.#options.modelFilter, { provider, model })
    )
      return;
    const mapped = this.#options.modelAliases?.get(model) ?? model;
    const hourStart = this.#hourStartFor(slot.hourIndex);
    const hour = this.#toHourOfDay(timestampMs);
    const key = `${slot.day}\u0000${hourStart}\u0000${provider}\u0000${mapped}\u0000${tier}\u0000${hour}`;
    const held = this.#generationTimings.get(key);
    this.#generationTimings.set(key, {
      day: slot.day as UsageDay,
      ...(hourStart === "" ? {} : { hourStart }),
      provider,
      model: mapped,
      hour,
      ...(tier === "standard" ? {} : { tier }),
      outputTokens: (held?.outputTokens ?? 0) + outputTokens,
      generationMs: (held?.generationMs ?? 0) + Math.round(generationMs),
    });
  }

  addCompletedTurn(
    timestampMs: number,
    provider: UsageProviderKind,
    model: string,
    tier: UsageSpeed,
    durationMs: number,
  ): void {
    if (
      this.#slotFor(timestampMs) === null ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      !keepsUsageRecord(this.#options.modelFilter, { provider, model })
    )
      return;
    const mapped = this.#options.modelAliases?.get(model) ?? model;
    const key = `${provider}\u0000${mapped}\u0000${tier}`;
    let entry = this.#turnTimings.get(key);
    if (entry === undefined) {
      entry = { provider, model: mapped, tier, durationsMs: [] };
      this.#turnTimings.set(key, entry);
    }
    entry.durationsMs.push(Math.round(durationMs));
  }

  /** A prompt from the server's own records; counted apart from usage records and their de-duplication. */
  addServerPrompt(
    kind: UsageServerPromptKind,
    timestampMs: number,
    provider: UsageProviderKind,
    model: string,
  ): void {
    const slot = this.#slotFor(timestampMs);
    if (slot === null) return;
    const mapped = this.#options.modelAliases?.get(model) ?? model;
    const key = `${slot.day}\u0000${this.#hourStartFor(slot.hourIndex)}\u0000${provider}\u0000${mapped}`;
    const counts = this.#serverPrompts.get(kind) ?? new Map<string, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.#serverPrompts.set(kind, counts);
  }

  /** The day and hour a timestamp falls in, or null outside the requested window. */
  #slotFor(timestampMs: number): { readonly day: string; readonly hourIndex: number } | null {
    if (
      this.#hourlyWindow !== null &&
      (timestampMs < this.#hourlyWindow.sinceTimeMs ||
        timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      return null;
    }
    const day = this.#toDay(timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      return null;
    }
    const hourIndex =
      this.#hourlyWindow === null
        ? -1
        : Math.floor((timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
    return { day, hourIndex };
  }

  #hourStartFor(hourIndex: number): string {
    const window = this.#hourlyWindow;
    return window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
  }

  // Aliases use the target's rate. Only an unpriced target goes through the provider's own rate naming.
  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    const rateModel =
      lookupRate(this.#options.rates, model) === null
        ? this.#options.rateModel?.(record.provider, model)
        : undefined;
    return rateModel === undefined ? { ...rest, model } : { ...rest, model, rateModel };
  }

  // Time-ordered records usually reuse the previous bucket; avoid rebuilding its key.
  #bucketFor(
    day: string,
    hourIndex: number,
    provider: string,
    model: string,
    source: string,
  ): MutableBucket {
    const last = this.#lastBucket;
    if (
      last !== null &&
      last.day === day &&
      last.hourIndex === hourIndex &&
      last.provider === provider &&
      last.model === model &&
      last.source === source
    ) {
      return last.bucket;
    }
    const hourStart = this.#hourStartFor(hourIndex);
    const key = `${day}\u0000${hourStart}\u0000${provider}\u0000${model}\u0000${source}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: { ...EMPTY_TOTALS },
        costUsd: 0,
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        records: 0,
        prompts: 0,
        speed: null,
        unpricedRecords: 0,
        unpricedTokens: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }
    this.#lastBucket = { day, hourIndex, provider, model, source, bucket };
    return bucket;
  }

  finish(): AggregateResult {
    for (const { record, bucket } of this.#seen.values()) {
      if (bucket !== null) this.#accumulate(bucket, record);
    }
    this.#seen.clear();
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] =
        key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sourcePath === "" ? {} : { sourcePath }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        ...(bucket.prompts === 0 ? {} : { prompts: bucket.prompts }),
        ...(bucket.speed === null
          ? {}
          : {
              speed: [...bucket.speed].flatMap(([tier, hours]) =>
                hours.flatMap((sample, hour) =>
                  sample.generationMs === 0
                    ? []
                    : [
                        {
                          hour,
                          outputTokens: sample.outputTokens,
                          generationMs: Math.round(sample.generationMs),
                          ...(tier === "standard" ? {} : { tier }),
                        },
                      ],
                ),
              ),
            }),
        unpricedRecords: bucket.unpricedRecords,
        unpricedTokens: bucket.unpricedTokens,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    const serverPrompts: Partial<Record<UsageServerPromptKind, UsageServerPrompts[]>> = {};
    for (const [kind, counts] of this.#serverPrompts) {
      serverPrompts[kind] = [...counts].map(([key, count]) => {
        const [day = "", hourStart = "", provider = "", model = ""] = key.split("\u0000");
        return {
          day: day as UsageDay,
          ...(hourStart === "" ? {} : { hourStart }),
          provider: provider as UsageProviderKind,
          model,
          count,
        };
      });
    }

    return {
      buckets,
      serverPrompts,
      turnTimings: [...this.#turnTimings.values()],
      generationTimings: [...this.#generationTimings.values()],
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
