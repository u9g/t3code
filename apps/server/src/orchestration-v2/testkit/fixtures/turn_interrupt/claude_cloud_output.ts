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
  TURN_INTERRUPT_PROMPT,
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

export function assertTurnInterruptClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // Stop came before the cloud ran the prompt, so the cloud dropped it and no
  // result was ever going to end the turn.
  const offeredUuids = framesOfType(transcript, "prompt.offer").map((frame) =>
    Reflect.get(Reflect.get(frame, "message"), "uuid"),
  );
  const receipts = framesOfType(transcript, "query.interrupted");
  assert.lengthOf(receipts, 1);
  assert.deepEqual(Reflect.get(receipts[0]!, "cancelled"), offeredUuids);
  assert.lengthOf(framesOfType(transcript, "result"), 0);

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertClaudeCloudStartupNotice(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);
  assert.isFalse(projection.turnItems.some((item) => item.type === "assistant_message"));

  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(interruptRequest?.status, "completed");
  assert.equal(interruptResult?.status, "interrupted");
  assert.equal(interruptResult?.parentItemId, interruptRequest?.id);
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
