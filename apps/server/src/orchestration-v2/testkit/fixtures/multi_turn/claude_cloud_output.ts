import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertClaudeCloudStartupNotice, projectionFor } from "../shared.ts";
import { assertMultiTurnClaudeOutput } from "./claude_output.ts";

export function assertMultiTurnClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnClaudeOutput(result, transcript);
  assertClaudeCloudStartupNotice(projectionFor(result, transcript.scenario));
}
