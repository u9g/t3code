import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const slackMessagePreview = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:slack:message-preview",
  tag: WS_METHODS.slackMessagePreview,
  staleTimeMs: 60_000,
});
