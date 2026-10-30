import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const ClaudeUserSettings = Schema.Struct({
  remote: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ defaultEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
  attribution: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commit: Schema.optionalKey(Schema.String),
        pr: Schema.optionalKey(Schema.String),
        sessionUrl: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export type ClaudeUserSettings = typeof ClaudeUserSettings.Type;
const decodeClaudeUserSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClaudeUserSettings),
);

/**
 * The settings this machine's `claude` CLI keeps in `<configDir>/settings.json`. A cloud session
 * never reads them, so those that should follow the user there are read here. A missing or
 * unreadable file reads as no settings.
 */
export const readClaudeUserSettings = Effect.fn("readClaudeUserSettings")(
  function* (configDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem
      .readFileString(path.join(configDir, "settings.json"))
      .pipe(Effect.flatMap(decodeClaudeUserSettings));
  },
  Effect.orElseSucceed((): ClaudeUserSettings => ({})),
);
