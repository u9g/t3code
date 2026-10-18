import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import type { ClaudeCloudEnvironment } from "./ClaudeCloudApi.ts";
import * as ClaudeCloudEnvironmentChoice from "./ClaudeCloudEnvironment.ts";

const LISTED: ReadonlyArray<ClaudeCloudEnvironment> = [
  { id: "env_bridge", kind: "bridge" },
  { id: "env_wishblock", kind: "anthropic_cloud" },
  { id: "env_default", kind: "anthropic_cloud" },
];

const makeConfigDir = (settings: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-env-" });
    if (settings !== undefined) {
      yield* fileSystem.writeFileString(path.join(configDir, "settings.json"), settings);
    }
    return configDir;
  });

const choose = (input: {
  readonly environmentId?: string;
  readonly settings?: string;
  readonly environments?: ReadonlyArray<ClaudeCloudEnvironment>;
}) =>
  Effect.gen(function* () {
    let listed = 0;
    const configDir = yield* makeConfigDir(input.settings);
    const result = yield* ClaudeCloudEnvironmentChoice.resolveClaudeCloudEnvironment({
      environmentId: input.environmentId,
      configDir,
      listEnvironments: Effect.sync(() => {
        listed += 1;
        return input.environments ?? LISTED;
      }),
    }).pipe(Effect.result);
    return { result, listed };
  });

const claudeDefault = (id: string) =>
  JSON.stringify({ model: "opus", remote: { defaultEnvironmentId: id } });

it.layer(NodeServices.layer)("resolveClaudeCloudEnvironment", (it) => {
  it.effect("uses the provider setting as given, without listing", () =>
    Effect.gen(function* () {
      expect(
        yield* choose({ environmentId: " env_chosen ", settings: claudeDefault("env_default") }),
      ).toEqual({
        result: Result.succeed("env_chosen"),
        listed: 0,
      });
    }),
  );

  it.effect("uses the CLI's default environment while it is still listed", () =>
    Effect.gen(function* () {
      expect(
        yield* choose({ environmentId: "  ", settings: claudeDefault("env_default") }),
      ).toEqual({
        result: Result.succeed("env_default"),
        listed: 1,
      });
      expect(yield* choose({ settings: claudeDefault("ccpool_01") })).toEqual({
        result: Result.succeed("ccpool_01"),
        listed: 0,
      });
    }),
  );

  it.effect("falls back to the first anthropic_cloud environment", () =>
    Effect.gen(function* () {
      const expected = {
        result: Result.succeed("env_wishblock"),
        listed: 1,
      };
      expect(yield* choose({ settings: claudeDefault("env_deleted") })).toEqual(expected);
      expect(yield* choose({})).toEqual(expected);
      expect(yield* choose({ settings: "{not json" })).toEqual(expected);
      expect(yield* choose({ settings: JSON.stringify({ remote: null }) })).toEqual(expected);
    }),
  );

  it.effect("fails when no cloud environment is available", () =>
    Effect.gen(function* () {
      const { result } = yield* choose({ environments: [LISTED[0]!] });
      expect(result).toMatchObject(
        Result.fail({ _tag: "ClaudeCloudNoEnvironmentError", environmentCount: 1 }),
      );
    }),
  );
});
