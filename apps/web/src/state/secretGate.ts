import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type SecretGatePrompt, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuerySelector } from "./query";

/** The secretgate Touch ID prompt on the environment's machine screen. */
const secretGatePrompt = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:secretgate:prompt",
  tag: WS_METHODS.subscribeSecretGatePrompt,
});

const selectThreadId = (result: AsyncResult.AsyncResult<SecretGatePrompt, unknown>) =>
  AsyncResult.getOrElse(result, () => null)?.threadId ?? null;

/** The thread whose secretgate Touch ID prompt is on screen, if any. */
export function useSecretGatePromptThreadId(environmentId: EnvironmentId | null): string | null {
  return useEnvironmentQuerySelector(
    environmentId === null ? null : secretGatePrompt({ environmentId, input: {} }),
    selectThreadId,
  );
}
