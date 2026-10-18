import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ClaudeCloudEnvironment } from "./ClaudeCloudApi.ts";

export class ClaudeCloudNoEnvironmentError extends Schema.TaggedError<ClaudeCloudNoEnvironmentError>()(
  "ClaudeCloudNoEnvironmentError",
  { environmentCount: Schema.Number },
) {
  override get message(): string {
    return "Claude Cloud found no cloud environment to run in. Create one at https://claude.ai/code, or choose one in this provider's settings.";
  }
}

const ClaudeUserSettings = Schema.Struct({
  remote: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ defaultEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const decodeClaudeUserSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClaudeUserSettings),
);

/** `remote.defaultEnvironmentId` from `<configDir>/settings.json`, as set by the CLI's `/remote-env`. */
const readClaudeDefaultEnvironmentId = Effect.fn(
  "ClaudeCloudEnvironment.readClaudeDefaultEnvironmentId",
)(
  function* (configDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* fileSystem
      .readFileString(path.join(configDir, "settings.json"))
      .pipe(Effect.flatMap(decodeClaudeUserSettings));
    return settings.remote?.defaultEnvironmentId?.trim() || undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

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
  const claudeDefault = yield* readClaudeDefaultEnvironmentId(input.configDir);
  if (claudeDefault !== undefined && isSelfHostedPool(claudeDefault)) return claudeDefault;
  const environments = yield* input.listEnvironments;
  const chosen =
    environments.find((environment) => environment.id === claudeDefault) ??
    environments.find((environment) => environment.kind === "anthropic_cloud");
  if (chosen !== undefined) return chosen.id;
  return yield* new ClaudeCloudNoEnvironmentError({ environmentCount: environments.length });
});
