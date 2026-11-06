import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertClaudeCloudStartupNotice,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
} from "../shared.ts";

function framesOfType(transcript: ProviderReplayTranscript, type: string) {
  return transcript.entries.flatMap((entry) =>
    entry.type !== "runtime_exit" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "type") === type
      ? [entry.frame]
      : [],
  );
}

export function assertTurnInterruptRestartClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // Stop leaves the cloud session attached, so the next turn goes out on the
  // same query instead of a resumed one.
  assert.lengthOf(framesOfType(transcript, "query.open"), 1);
  assert.lengthOf(framesOfType(transcript, "prompt.offer"), 2);

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertClaudeCloudStartupNotice(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
    "assistant_message",
  ]);
  assertUserMessagesInclude(projection, [
    TURN_INTERRUPT_MID_TOOL_PROMPT,
    TURN_INTERRUPT_RECOVERY_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "interrupt recovery fixture complete");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  assert.lengthOf(projection.providerThreads, 1);
  assert.equal(projection.providerThreads[0]?.status, "idle");
}
