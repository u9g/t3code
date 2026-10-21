import { describe, expect, it } from "@effect/vitest";

import { claudeUsageFormat, parseClaudeLine } from "./claudeUsage.ts";

function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
  speed?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
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
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }), {
      pendingPrompts: 0,
    });

    expect(record).not.toBeNull();
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
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }), {
      pendingPrompts: 0,
    });
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }), {
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
    for (const line of lines) expect(parseClaudeLine(line, state)).toBeNull();

    const first = parseClaudeLine(claudeLine({ messageId: "msg_p", contentType: "text" }), state);
    const second = parseClaudeLine(
      claudeLine({ messageId: "msg_p", contentType: "tool_use" }),
      state,
    );
    expect(first?.prompts).toBe(2);
    expect(second?.prompts).toBeUndefined();
  });
});
