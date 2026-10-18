import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import {
  claudeCloudFilesDir,
  claudeCloudThreadFolder,
} from "../provider/claudeCloud/ClaudeCloudFiles.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const FILE_UUID = "d56e0bb8-4d97-4899-9e40-56adcab71b5c";

const layerResourceCleanup = ResourceCleanupService.layer.pipe(
  Layer.provide(
    Layer.merge(
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(PreviewManager.PreviewManager)({}),
    ),
  ),
);
const layerServerState = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerTest = layerResourceCleanup.pipe(Layer.provideMerge(layerServerState));
const layerFailingRemoval = layerResourceCleanup.pipe(
  Layer.provide(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return {
          ...fileSystem,
          remove: (path) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: path,
                description: "A player has the video open.",
              }),
            ),
        } satisfies FileSystem.FileSystem;
      }),
    ),
  ),
  Layer.provideMerge(layerServerState),
);

/** Saves a file where Claude Cloud keeps the thread's downloads. */
const saveSentFile = Effect.fn("ResourceCleanupServiceTest.saveSentFile")(function* (
  threadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* claudeCloudFilesDir,
    claudeCloudThreadFolder(threadId) ?? assert.fail(`${threadId} has no folder`),
    FILE_UUID,
  );
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const file = path.join(directory, "clip.mp4");
  yield* fileSystem.writeFileString(file, "video bytes");
  return file;
});

describe("cleanupProviderFiles", () => {
  it.effect("removes a thread's downloads and leaves other threads' alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const deleted = yield* saveSentFile("thread:a");
      const kept = yield* saveSentFile("thread:b");

      yield* cleanup.cleanupProviderFiles("thread:a");

      assert.isFalse(yield* fileSystem.exists(path.dirname(path.dirname(deleted))));
      assert.equal(yield* fileSystem.readFileString(kept), "video bytes");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses an id that can't name a folder of its own, touching nothing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const kept = yield* saveSentFile("thread:b");
      const settings = path.join(config.stateDir, "settings.json");
      yield* fileSystem.writeFileString(settings, "{}");

      for (const threadId of [".", ".."]) {
        yield* cleanup.cleanupProviderFiles(threadId);
      }

      assert.equal(yield* fileSystem.readFileString(kept), "video bytes");
      assert.equal(yield* fileSystem.readFileString(settings), "{}");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("succeeds for a thread that downloaded nothing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;

      yield* cleanup.cleanupProviderFiles("thread:a");
      assert.isFalse(yield* fileSystem.exists(yield* claudeCloudFilesDir));
      yield* saveSentFile("thread:b");
      yield* cleanup.cleanupProviderFiles("thread:a");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports a removal it could not make", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const file = yield* saveSentFile("thread:a");

      const error = yield* cleanup.cleanupProviderFiles("thread:a").pipe(Effect.flip);

      assert.equal(error.operation, "provider-files");
      assert.equal(error.threadId, "thread:a");
      assert.isTrue(yield* fileSystem.exists(file));
    }).pipe(Effect.provide(layerFailingRemoval)),
  );
});
