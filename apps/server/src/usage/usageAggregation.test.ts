import { describe, expect, it } from "@effect/vitest";

import { resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      cacheCreation1hCostPerToken: 2e-5,
      fast: {
        inputCostPerToken: 2e-5,
        outputCostPerToken: 1e-4,
        cacheReadCostPerToken: 2e-6,
        cacheCreationCostPerToken: 2.5e-5,
        cacheCreation1hCostPerToken: 4e-5,
      },
      ultrafast: null,
      contextTiers: [],
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("splits a bucket's cost by category and speed", () => {
    const [bucket] = aggregate([record(), record({ speed: "fast" })]).buckets;

    expect(bucket).toMatchObject({
      costUsd: expect.closeTo(0.016875),
      categoryCostUsd: {
        input: expect.closeTo(0.003),
        cacheRead: expect.closeTo(0.003),
        cacheWrite: expect.closeTo(0.000375),
        output: expect.closeTo(0.0075),
      },
      fastCostUsd: expect.closeTo(0.01125),
      speedPremiumUsd: expect.closeTo(0.005625),
    });
    expect(bucket).not.toHaveProperty("ultrafastCostUsd");
  });

  it("merges partial copies of a key by channel maximum in the first copy's bucket", () => {
    const zeroTotals = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    const partial = record({
      dedupeKey: "msg_1:",
      speed: "fast",
      reportedCostUsd: 1,
      totals: { ...record().totals, cachedInputTokens: 1200, outputTokens: 3, reasoningTokens: 5 },
    });
    const complete = record({
      dedupeKey: "msg_1:",
      model: "claude-fable-5[1m]",
      timestampMs: Date.parse("2026-08-08T12:00:00Z"),
      sessionId: "session-fork",
      reportedCostUsd: 2,
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 1000,
        cacheCreationTokens: 40,
        outputTokens: 264,
        reasoningTokens: 135,
      },
    });
    const zero = { ...partial, totals: zeroTotals, reportedCostUsd: null };
    const merged = {
      reportedCostUsd: 2,
      totals: { ...complete.totals, uncachedInputTokens: 100, cachedInputTokens: 1200 },
    };

    for (const copies of [
      [zero, partial, complete, complete],
      [complete, partial, zero, zero],
    ]) {
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-31",
        rates,
      });
      copies.forEach((copy, index) => aggregator.add(copy, `${index}.jsonl`));
      const result = aggregator.finish();
      const expected = aggregate([{ ...copies[0]!, ...merged }]).buckets[0];

      expect(result.duplicatesDropped).toBe(3);
      expect(result.buckets).toEqual([{ ...expected, sourcePath: "0.jsonl" }]);
    }
  });

  it("keeps a live Grok turn over a saved pre-v17 maximum in either source order", () => {
    const turn = (timestampMs: number, outputTokens: number) =>
      record({
        provider: "grok",
        model: "grok-4.5",
        timestampMs,
        dedupeKey: `s:p:${timestampMs}:grok-4.5`,
        reportedCostUsd: outputTokens / 10,
        totals: { ...record().totals, uncachedInputTokens: 0, outputTokens },
      });
    const first = turn(Date.parse("2026-08-08T10:00:00Z"), 10);
    const resumed = turn(Date.parse("2026-08-08T11:00:00Z"), 20);
    const savedMaximum = { ...first, totals: resumed.totals, reportedCostUsd: 2 };

    const expected = aggregate([first, resumed]).buckets;

    for (const order of [
      [first, resumed, savedMaximum],
      [savedMaximum, first, resumed],
    ]) {
      const result = aggregate(order);
      expect(result.duplicatesDropped).toBe(1);
      expect(result.buckets).toEqual(expected);
    }
  });

  it("does not count a key whose first copy fell outside the window", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:", timestampMs: Date.parse("2026-07-01T12:00:00Z") }),
      record({ dedupeKey: "msg_1:", totals: { ...record().totals, outputTokens: 500 } }),
    ]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("sums timed output by local hour of day and leaves untimed responses out", () => {
    const at = (iso: string, generationMs?: number) =>
      record({
        timestampMs: Date.parse(iso),
        ...(generationMs === undefined ? {} : { generationMs }),
      });
    const [bucket] = aggregate(
      [
        at("2026-08-07T13:05:00Z", 1000),
        at("2026-08-07T13:55:00Z", 4000),
        at("2026-08-07T15:30:00Z", 500),
        at("2026-08-07T16:00:00Z"),
      ],
      "America/New_York",
    ).buckets;

    expect(bucket?.speed).toEqual([
      { hour: 9, outputTokens: 100, generationMs: 5000 },
      { hour: 11, outputTokens: 50, generationMs: 500 },
    ]);
    expect(aggregate([record()]).buckets[0]).not.toHaveProperty("speed");
  });

  it("tags timed output from fast responses with its tier", () => {
    const [bucket] = aggregate([
      record({ generationMs: 1000 }),
      record({ generationMs: 500, speed: "fast" }),
    ]).buckets;
    expect(bucket?.speed?.map(({ tier, generationMs }) => ({ tier, generationMs }))).toEqual([
      { tier: undefined, generationMs: 1000 },
      { tier: "fast", generationMs: 500 },
    ]);
  });

  it("finds the day at a quarter-hour zone's midnight across interleaved buckets", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T18:14:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z"), model: "claude-opus-5" }),
        record({ timestampMs: Date.parse("2026-08-01T18:16:00.000Z") }),
      ],
      "Asia/Kathmandu",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.model, bucket.records])).toEqual([
      ["2026-08-01", "claude-fable-5", 1],
      ["2026-08-02", "claude-fable-5", 2],
      ["2026-08-02", "claude-opus-5", 1],
    ]);
  });

  it("finds the day at a fixed offset's midnight between quarter hours", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T23:58:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T23:59:00.000Z") }),
      ],
      "+00:01",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.records])).toEqual([
      ["2026-08-01", 1],
      ["2026-08-02", 1],
    ]);
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("folds a mapped model into its target and prices it there", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      modelAliases: resolveModelAliases({ "example-preview": "claude-fable-5" }),
      rateModel: () => "claude-fable",
    });
    aggregator.add(record());
    aggregator.add(record({ model: "example-preview", rateModel: "example-preview-high" }));
    const result = aggregator.finish();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.model).toBe("claude-fable-5");
    expect(result.buckets[0]?.records).toBe(2);
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.00925, 9);
    expect(result.buckets[0]?.unpricedRecords).toBe(0);
  });
});

describe("resolveModelAliases", () => {
  it("follows chains to the final model and drops chains that enter a loop", () => {
    expect([
      ...resolveModelAliases({
        "preview[1m]": "preview",
        preview: "example-model",
        shared: "preview",
        intoLoop: "loop",
        loop: "back",
        back: "loop",
        laterIntoLoop: "back",
        deepIntoLoop: "intoLoop",
        self: "self",
        validAfterLoops: "shared",
      }),
    ]).toEqual([
      ["preview[1m]", "example-model"],
      ["preview", "example-model"],
      ["shared", "example-model"],
      ["validAfterLoops", "example-model"],
    ]);
  });
});

describe("server prompts", () => {
  it("keeps completed-turn durations inside the exact window, filtered before aliases and separated by tier", () => {
    for (const resolution of ["day", "hour"] as const) {
      const aggregator = new UsageAggregator({
        timeZone: "America/Los_Angeles",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-01",
        resolution,
        sinceTimeMs: Date.parse("2026-08-01T07:00:00Z"),
        untilTimeMs: Date.parse("2026-08-02T07:00:00Z"),
        rates,
        modelAliases: resolveModelAliases({ preview: "aliased" }),
        modelFilter: { exclude: [{ model: "excluded" }] },
      });
      for (const [at, model, tier, ms] of [
        ["2026-08-01T06:59:59Z", "preview", "standard", 900],
        ["2026-08-01T07:00:00Z", "preview", "standard", 1000],
        ["2026-08-02T06:59:59Z", "preview", "fast", 2000],
        ["2026-08-02T07:00:00Z", "preview", "standard", 900],
        ["2026-08-01T08:00:00Z", "excluded", "standard", 900],
        ["2026-08-01T08:00:00Z", "preview", "standard", -1],
        ["2026-08-01T08:00:00Z", "preview", "standard", NaN],
      ] as const)
        aggregator.addCompletedTurn(Date.parse(at), "codex", model, tier, ms);
      expect(aggregator.finish().turnTimings).toEqual([
        { provider: "codex", model: "aliased", tier: "standard", durationsMs: [1000] },
        { provider: "codex", model: "aliased", tier: "fast", durationsMs: [2000] },
      ]);
    }
  });

  it("counts each kind by day, provider and aliased model, inside the window only", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      resolution: "day",
      rates,
      modelAliases: resolveModelAliases({ "claude-fable-5-preview": "claude-fable-5" }),
    });
    aggregator.addServerPrompt(
      "scheduledPrompts",
      Date.parse("2026-08-02T10:00:00Z"),
      "claude",
      "claude-fable-5-preview",
    );
    aggregator.addServerPrompt(
      "scheduledPrompts",
      Date.parse("2026-08-02T11:00:00Z"),
      "claude",
      "claude-fable-5",
    );
    aggregator.addServerPrompt(
      "scheduledPrompts",
      Date.parse("2026-09-02T10:00:00Z"),
      "claude",
      "claude-fable-5",
    );
    aggregator.addServerPrompt(
      "delegatedPrompts",
      Date.parse("2026-08-02T12:00:00Z"),
      "codex",
      "gpt-6-sol",
    );

    const result = aggregator.finish();
    expect(result.serverPrompts).toEqual({
      scheduledPrompts: [
        { day: "2026-08-02", provider: "claude", model: "claude-fable-5", count: 2 },
      ],
      delegatedPrompts: [{ day: "2026-08-02", provider: "codex", model: "gpt-6-sol", count: 1 }],
    });
    expect(result.buckets).toEqual([]);
  });
});
