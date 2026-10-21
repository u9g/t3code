import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * T3 Code writes one record per assistant *content block*, and every one of those records repeats
 * the same complete `usage` object for the parent message. Summing them overcounts by roughly
 * 2.4x on a real workload, so the caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string, state: ClaudeScanState): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseClaudeRecord(parsed, state);
}

/** Prompts seen since the session's last response; the next response carries them. */
export const ClaudeScanState = Schema.Struct({
  pendingPrompts: Schema.mutableKey(Schema.Int),
});
export type ClaudeScanState = typeof ClaudeScanState.Type;

// Claude Code records these as user messages, but they are its own output, not a prompt.
const AUTOMATED_USER_TEXT =
  /^(<(task-notification|command-[a-z]+|local-command-[a-z]+|bash-[a-z]+|system-reminder)>|\[Request interrupted)/u;

/** A message the user sent: not a tool result, subagent, meta note or compaction summary. */
function isUserPrompt(record: Record<string, unknown>): boolean {
  if (record["isSidechain"] === true || record["isMeta"] === true) return false;
  if (record["isCompactSummary"] === true) return false;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return false;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return !AUTOMATED_USER_TEXT.test(content.trimStart());
  if (!Array.isArray(content)) return false;
  const types = new Set(
    content.map((block) =>
      typeof block === "object" && block !== null
        ? (block as Record<string, unknown>)["type"]
        : null,
    ),
  );
  return !types.has("tool_result") && (types.has("text") || types.has("image"));
}

function parseClaudeRecord(parsed: unknown, state: ClaudeScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  if (record["type"] === "user") {
    if (isUserPrompt(record)) state.pendingPrompts += 1;
    return [];
  }
  if (record["type"] !== "assistant") return [];

  const message = record["message"];
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return [];

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];
  const prompts = state.pendingPrompts;
  state.pendingPrompts = 0;

  const executor: UsageRecord = {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
    ...(prompts > 0 ? { prompts } : {}),
  };

  // Top-level `usage` is the executor's alone. Advisor calls run on another model at its own rates
  // and appear only in `iterations`, so each one is its own record under that model.
  const records = [executor];
  const iterations: readonly unknown[] = Array.isArray(usageRecord["iterations"])
    ? usageRecord["iterations"]
    : [];
  for (const [index, iteration] of iterations.entries()) {
    if (typeof iteration !== "object" || iteration === null) continue;
    const advisor = iteration as Record<string, unknown>;
    if (advisor["type"] !== "advisor_message") continue;

    const advisorModel = typeof advisor["model"] === "string" ? advisor["model"] : "";
    if (advisorModel.length === 0 || advisorModel === CLAUDE_SYNTHETIC_MODEL) continue;

    records.push({
      provider: "claude",
      timestampMs,
      model: advisorModel,
      sessionId: executor.sessionId,
      totals: {
        uncachedInputTokens: tokenCount(advisor["input_tokens"]),
        cachedInputTokens: tokenCount(advisor["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(advisor["cache_creation_input_tokens"]),
        outputTokens: tokenCount(advisor["output_tokens"]),
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

export const claudeUsageFormat: TranscriptUsageFormat<ClaudeScanState> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    isSidechain: true,
    isMeta: true,
    isCompactSummary: true,
    message: { id: true, model: true, usage: true, content: true },
  },
  usageMarkers: ['"usage"', '"type":"user"'],
  parseLine: (line, state) => parseClaudeLine(line, state),
  parseProjected: (projected, state) => parseClaudeRecord(projected, state),
  state: { initial: () => ({ pendingPrompts: 0 }), schema: ClaudeScanState },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.homePath.trim();
    const home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
