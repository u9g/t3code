import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ClaudeCloudEnvironment } from "./ClaudeCloudApi.ts";
import { readClaudeUserSettings } from "./ClaudeUserSettings.ts";

export class ClaudeCloudNoEnvironmentError extends Schema.TaggedError<ClaudeCloudNoEnvironmentError>()(
  "ClaudeCloudNoEnvironmentError",
  { environmentCount: Schema.Number },
) {
  override get message(): string {
    return "Claude Cloud found no cloud environment to run in. Create one at https://claude.ai/code, or choose one in this provider's settings.";
  }
}

const isSelfHostedPool = (id: string) => id.startsWith("ccpool_");

/**
 * The environment a new session runs in: T3's `environmentId` setting as given, else the CLI's
 * default while it is still listed or names a self-hosted pool (the CLI also falls back past a
 * stale one), else the first `anthropic_cloud` environment. Lists environments only when needed.
 */
export const resolveClaudeCloudEnvironment = Effect.fn("resolveClaudeCloudEnvironment")(function* <
  E,
  R,
>(input: {
  readonly environmentId: string | undefined;
  readonly configDir: string;
  readonly listEnvironments: Effect.Effect<ReadonlyArray<ClaudeCloudEnvironment>, E, R>;
}) {
  const configured = input.environmentId?.trim();
  if (configured) return configured;
  // `remote.defaultEnvironmentId`, as set by the CLI's `/remote-env`.
  const claudeDefault =
    (yield* readClaudeUserSettings(input.configDir)).remote?.defaultEnvironmentId?.trim() ||
    undefined;
  if (claudeDefault !== undefined && isSelfHostedPool(claudeDefault)) return claudeDefault;
  const environments = yield* input.listEnvironments;
  const chosen =
    environments.find((environment) => environment.id === claudeDefault) ??
    environments.find((environment) => environment.kind === "anthropic_cloud");
  if (chosen !== undefined) return chosen.id;
  return yield* new ClaudeCloudNoEnvironmentError({ environmentCount: environments.length });
});
