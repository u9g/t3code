import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertClaudeCloudStartupNotice,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
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

export function assertTurnInterruptMidToolClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // The command was running, so the cloud cancelled nothing and ended the turn
  // itself, with an aborted result on the query that stayed attached.
  const receipts = framesOfType(transcript, "query.interrupted");
  assert.lengthOf(receipts, 1);
  assert.deepEqual(Reflect.get(receipts[0]!, "cancelled"), []);
  const results = framesOfType(transcript, "result");
  assert.lengthOf(results, 1);
  assert.equal(Reflect.get(results[0]!, "subtype"), "error_during_execution");
  assert.equal(Reflect.get(results[0]!, "terminal_reason"), "aborted_tools");
  assert.lengthOf(framesOfType(transcript, "query.open"), 1);

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertClaudeCloudStartupNotice(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  // The cloud answers the stopped command with a rejected tool result, which
  // shows as interrupted, as local Claude shows a command cut off by Stop.
  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.include(commandItem?.input, "node -e");
  assert.equal(commandItem?.status, "interrupted");
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(interruptResult?.status, "interrupted");
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
