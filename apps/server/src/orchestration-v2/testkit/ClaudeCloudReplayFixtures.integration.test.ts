import { describe } from "@effect/vitest";

import { ClaudeCloudOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Claude Cloud replay fixtures", () => {
  itRunsReplayFixtures("claudeCloud", (input) =>
    runReplayFixture({ ...input, harness: ClaudeCloudOrchestratorReplayHarness }),
  );
});
