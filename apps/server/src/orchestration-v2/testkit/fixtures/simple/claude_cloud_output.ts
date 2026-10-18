import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertClaudeCloudStartupNotice, projectionFor } from "../shared.ts";
import { assertSimpleClaudeOutput } from "./claude_output.ts";

export function assertSimpleClaudeCloudOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleClaudeOutput(result, transcript);
  assertClaudeCloudStartupNotice(projectionFor(result, transcript.scenario));
}
