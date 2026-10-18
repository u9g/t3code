import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertClaudeCloudStartupNotice, projectionFor } from "../shared.ts";
import { assertProposedPlanOutput } from "./codex_output.ts";

export function assertProposedPlanClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // The cloud asks before ExitPlanMode like a local session does, and T3 keeps
  // the plan and turns the tool down.
  const answers = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && entry.label === "permission.response:ExitPlanMode"
      ? [entry.frame]
      : [],
  );
  assert.lengthOf(answers, 1);
  assert.equal(Reflect.get(Reflect.get(answers[0]!, "result"), "behavior"), "deny");

  assertProposedPlanOutput(result, transcript);
  const projection = projectionFor(result, transcript.scenario);
  assertClaudeCloudStartupNotice(projection);
  assert.equal(projection.runtimeRequests.length, 0);
}
