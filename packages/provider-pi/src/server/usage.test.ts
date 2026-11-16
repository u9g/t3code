import { describe, expect, it } from "@effect/vitest";

import { piUsageFormat } from "./usage.ts";

const completedTime = "2026-11-16T00:00:05.000Z";
const completedAt = Date.parse(completedTime);
const assistant = (timestamp: unknown) => ({
  type: "message",
  id: "response-1",
  timestamp: completedTime,
  message: {
    role: "assistant",
    provider: "baseten",
    model: "moonshotai/Kimi-K3.1-Pro",
    timestamp,
    usage: { input: 10, output: 100 },
  },
});

describe("Pi generation timing", () => {
  it("recovers each response's request time from native message timestamps", () => {
    const state = piUsageFormat.state!.initial();
    piUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-1" }), state);
    const [first] = piUsageFormat.parseLine(JSON.stringify(assistant(completedAt - 4500)), state);
    const [second] = piUsageFormat.parseProjected(
      {
        ...assistant(completedAt + 60_000),
        id: "response-2",
        timestamp: "2026-11-16T00:01:06.500Z",
      },
      state,
    );

    expect(first).toMatchObject({
      sessionId: "session-1",
      model: "baseten/moonshotai/Kimi-K3.1-Pro",
      generationMs: 4500,
      totals: { outputTokens: 100 },
    });
    expect(second?.generationMs).toBe(1500);
  });

  it.each([
    undefined,
    null,
    "unknown",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    completedAt,
    completedAt + 1,
    completedAt - 600_001,
  ])("keeps usage without inventing duration for invalid request timestamp %s", (timestamp) => {
    const [record] = piUsageFormat.parseProjected(
      assistant(timestamp),
      piUsageFormat.state!.initial(),
    );
    expect(record?.totals.outputTokens).toBe(100);
    expect(record).not.toHaveProperty("generationMs");
  });

  it.each(["usage", "compaction", "branch_summary", "toolResult"])(
    "does not time auxiliary %s usage as model output",
    (type) => {
      const message = { ...assistant(completedAt - 1000).message, role: type };
      const entry =
        type === "toolResult"
          ? { ...assistant(completedAt - 1000), message }
          : {
              ...assistant(completedAt - 1000),
              type,
              ...message,
              timestamp: completedTime,
            };
      const [record] = piUsageFormat.parseProjected(entry, piUsageFormat.state!.initial());
      expect(record?.totals.outputTokens).toBe(100);
      expect(record).not.toHaveProperty("generationMs");
    },
  );
});
