import { describe, expect, it } from "@effect/vitest";

import { parseRateTable, priceUsage } from "../../usage/usagePricing.ts";
import { claudeUsageFormat, parseClaudeLine } from "./claudeUsage.ts";

function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
  speed?: string;
  timestamp?: string;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: overrides.timestamp ?? "2026-08-07T04:05:13.944Z",
    ...(overrides.isSidechain ? { isSidechain: true } : {}),
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
        ...(overrides.speed === undefined ? {} : { speed: overrides.speed }),
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const [record] = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }), {
      pendingPrompts: 0,
    });

    expect(record).toBeDefined();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
    expect(record?.speed).toBe("standard");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // Content-block records repeat full parent usage; summing them overcounts.
    const [text] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }), {
      pendingPrompts: 0,
    });
    const [toolUse] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }), {
      pendingPrompts: 0,
    });

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("skips local placeholders in both reader paths but keeps real zero-token responses", () => {
    const projected = {
      type: "assistant",
      timestamp: "2026-08-07T04:05:13.944Z",
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    const expected = [
      expect.objectContaining({
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ];
    expect(claudeUsageFormat.parseLine(JSON.stringify(projected), { pendingPrompts: 0 })).toEqual(
      expected,
    );
    expect(claudeUsageFormat.parseProjected(projected, { pendingPrompts: 0 })).toEqual(expected);

    const synthetic = { ...projected, message: { ...projected.message, model: "<synthetic>" } };
    expect(claudeUsageFormat.parseLine(JSON.stringify(synthetic), { pendingPrompts: 0 })).toEqual(
      [],
    );
    expect(claudeUsageFormat.parseProjected(synthetic, { pendingPrompts: 0 })).toEqual([]);
  });
});

describe("Claude prompt counting", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

  it("counts typed prompts once, on the next response, and nothing Claude Code wrote itself", () => {
    const state = { pendingPrompts: 0 };
    const lines = [
      user("Fix the login bug"),
      user([{ type: "tool_result", content: "ok" }]),
      user("<task-notification>done</task-notification>"),
      user("<command-name>/compact</command-name>"),
      user("[Request interrupted by user for tool use]"),
      user("Summary of earlier turns", { isCompactSummary: true }),
      user("caveat", { isMeta: true }),
      user("subagent task", { isSidechain: true }),
      user([{ type: "text", text: "and this screenshot" }, { type: "image" }]),
    ];
    for (const line of lines) expect(parseClaudeLine(line, state)).toEqual([]);

    const [first] = parseClaudeLine(claudeLine({ messageId: "msg_p", contentType: "text" }), state);
    const [second] = parseClaudeLine(
      claudeLine({ messageId: "msg_p", contentType: "tool_use" }),
      state,
    );
    expect(first?.prompts).toBe(2);
    expect(second?.prompts).toBeUndefined();
  });

  it("times each response from the last user line on its own chain", () => {
    const state = { pendingPrompts: 0 };
    const at = (seconds: number) => `2026-08-07T04:05:${String(seconds).padStart(2, "0")}.000Z`;
    const timed = (line: string) => parseClaudeLine(line, state)[0]?.generationMs;
    const input = (seconds: number, extra: Record<string, unknown> = {}) =>
      parseClaudeLine(
        JSON.stringify({
          type: "user",
          timestamp: at(seconds),
          message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
          ...extra,
        }),
        state,
      );

    expect(timed(claudeLine({ messageId: "m0", contentType: "text", timestamp: at(1) }))).toBe(
      undefined,
    );
    input(10);
    input(12, { isSidechain: true });
    // Each block of a streamed message measures to its own write; dedupe keeps the latest.
    expect(timed(claudeLine({ messageId: "m1", contentType: "thinking", timestamp: at(13) }))).toBe(
      3000,
    );
    expect(timed(claudeLine({ messageId: "m1", contentType: "text", timestamp: at(15) }))).toBe(
      5000,
    );
    expect(
      timed(
        claudeLine({ messageId: "s1", contentType: "text", timestamp: at(14), isSidechain: true }),
      ),
    ).toBe(2000);
  });
});

describe("Claude advisor iterations", () => {
  const advisorTurn = {
    type: "assistant",
    timestamp: "2026-10-22T01:31:11.984Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 118320,
        cache_creation_input_tokens: 2676,
        output_tokens: 4506,
        speed: "standard",
        iterations: [
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 58352,
            cache_creation_input_tokens: 1616,
            output_tokens: 141,
          },
          {
            type: "advisor_message",
            model: "claude-fable-5-1",
            input_tokens: 54204,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
            output_tokens: 4229,
          },
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 59968,
            cache_creation_input_tokens: 1060,
            output_tokens: 4365,
          },
        ],
      },
    },
  };
  const withIterations = (iterations: readonly unknown[]) => ({
    ...advisorTurn,
    message: { ...advisorTurn.message, usage: { ...advisorTurn.message.usage, iterations } },
  });
  const parse = (turn: unknown) =>
    claudeUsageFormat.parseLine(JSON.stringify(turn), { pendingPrompts: 0 });

  it("reports the advisor model's tokens as their own record beside the unchanged executor record", () => {
    const executor = {
      provider: "claude",
      timestampMs: Date.parse("2026-10-22T01:31:11.984Z"),
      model: "claude-opus-5-5",
      sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
      totals: {
        uncachedInputTokens: 4,
        cachedInputTokens: 118320,
        cacheCreationTokens: 2676,
        outputTokens: 4506,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "msg_1:req_1",
    };
    const expected = [
      executor,
      {
        ...executor,
        model: "claude-fable-5-1",
        totals: {
          uncachedInputTokens: 54204,
          cachedInputTokens: 0,
          cacheCreationTokens: 500,
          outputTokens: 4229,
          reasoningTokens: 0,
        },
        cacheCreation1hTokens: 300,
        dedupeKey: expect.any(String),
      },
    ];

    expect(parse(advisorTurn)).toEqual(expected);
    expect(claudeUsageFormat.parseProjected(advisorTurn, { pendingPrompts: 0 })).toEqual(expected);
  });

  it("keys the advisor record apart from the executor and the same across a message's content blocks", () => {
    const block = (type: string) =>
      parse({ ...advisorTurn, message: { ...advisorTurn.message, content: [{ type }] } });
    const [executorKey, advisorKey] = block("text").map((record) => record.dedupeKey);

    expect(advisorKey).toEqual(expect.any(String));
    expect(advisorKey).not.toBe(executorKey);
    expect(block("tool_use").map((record) => record.dedupeKey)).toEqual([executorKey, advisorKey]);

    const unkeyed = parse({
      ...advisorTurn,
      requestId: undefined,
      message: { ...advisorTurn.message, id: undefined },
    });
    expect(unkeyed.map((record) => record.dedupeKey)).toEqual([null, null]);
  });

  it("emits only the executor record without an advisor iteration", () => {
    const executorIterations = advisorTurn.message.usage.iterations.filter(
      (iteration) => iteration.type === "message",
    );

    expect(parse(withIterations(executorIterations))).toHaveLength(1);
    expect(
      claudeUsageFormat.parseProjected(withIterations([]), { pendingPrompts: 0 }),
    ).toHaveLength(1);
    expect(
      claudeUsageFormat.parseLine(claudeLine({ messageId: "msg_3", contentType: "text" }), {
        pendingPrompts: 0,
      }),
    ).toHaveLength(1);
  });

  it("ignores advisor iterations without a usable model and malformed entries", () => {
    const unusable = withIterations([
      null,
      "advisor_message",
      { type: "advisor_message", input_tokens: 5 },
      { type: "advisor_message", model: "", input_tokens: 5 },
      { type: "advisor_message", model: "<synthetic>", input_tokens: 5 },
    ]);

    expect(parse(unusable).map((record) => record.model)).toEqual(["claude-opus-5-5"]);
  });
});

describe("Claude cache write pricing", () => {
  it("prices one-hour cache writes at the one-hour rate and the rest at the five-minute rate", () => {
    const model = "claude-opus-4-5-20251101";
    const rates = parseRateTable({
      [model]: {
        litellm_provider: "anthropic",
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 6.25e-6,
        cache_creation_input_token_cost_above_1hr: 1e-5,
      },
    });
    const [record] = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-07T04:05:13.944Z",
        sessionId: "s",
        message: {
          id: "msg_ttl",
          model,
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1_000_000,
            cache_creation: {
              ephemeral_5m_input_tokens: 400_000,
              ephemeral_1h_input_tokens: 600_000,
            },
            output_tokens: 0,
          },
        },
      }),
      { pendingPrompts: 0 },
    );

    if (record === undefined) throw new Error("expected a usage record");
    // 0.4M x $6.25/M + 0.6M x $10/M
    expect(priceUsage(rates, record).costUsd).toBeCloseTo(8.5, 9);
  });
});
