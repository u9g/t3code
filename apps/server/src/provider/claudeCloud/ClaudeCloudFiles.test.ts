// @effect-diagnostics nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  claudeCloudFilesDir,
  claudeCloudPartialFileName,
  claudeCloudThreadFolder,
  removeClaudeCloudThreadFiles,
  sweepClaudeCloudFiles,
} from "./ClaudeCloudFiles.ts";

const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const FILE_UUIDS = [
  "d56e0bb8-4d97-4899-9e40-56adcab71b5c",
  "0f1e2d3c-4b5a-4697-8877-665544332211",
  "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
] as const;

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-cloud-files-" })),
  Layer.provideMerge(NodeServices.layer),
);

const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("claudeCloud");

function thread(threadId: ThreadId, forkedFrom?: ThreadId): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:claude-cloud-files"),
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-opus-4-8" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom:
      forkedFrom === undefined
        ? null
        : { type: "run", threadId: forkedFrom, runId: RunId.make(`run:${forkedFrom}`) },
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const writeThread = Effect.fn("ClaudeCloudFilesTest.writeThread")(function* (
  threadId: ThreadId,
  state: "live" | "archived" | "deleted",
  forkedFrom?: ThreadId,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const base = { threadId, providerInstanceId, occurredAt: createdAt };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      ...base,
      id: EventId.make(`created:${threadId}`),
      type: "thread.created",
      payload: thread(threadId, forkedFrom),
    },
  ];
  if (state === "archived") {
    events.push({
      ...base,
      id: EventId.make(`archived:${threadId}`),
      type: "thread.archived",
      payload: { ...thread(threadId, forkedFrom), archivedAt: createdAt },
    });
  }
  yield* eventSink.write({ events });
  if (state === "deleted") yield* deleteThread(threadId, forkedFrom);
});

const deleteThread = Effect.fn("ClaudeCloudFilesTest.deleteThread")(function* (
  threadId: ThreadId,
  forkedFrom?: ThreadId,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  yield* eventSink.write({
    events: [
      {
        threadId,
        providerInstanceId,
        occurredAt: createdAt,
        id: EventId.make(`deleted:${threadId}`),
        type: "thread.deleted",
        payload: { ...thread(threadId, forkedFrom), deletedAt: createdAt },
      },
    ],
  });
});

/** The folder a thread's downloads go in, as the runner and deletion name it. */
const threadFiles = Effect.fn("ClaudeCloudFilesTest.threadFiles")(function* (threadId: string) {
  const path = yield* Path.Path;
  return path.join(
    yield* claudeCloudFilesDir,
    claudeCloudThreadFolder(threadId) ?? assert.fail(`${threadId} has no folder`),
  );
});

const writeFile = Effect.fn("ClaudeCloudFilesTest.writeFile")(function* (
  file: string,
  modifiedAtMs?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, "bytes");
  if (modifiedAtMs !== undefined) {
    // Node reads a numeric time as seconds.
    yield* fileSystem.utimes(file, modifiedAtMs / 1_000, modifiedAtMs / 1_000);
  }
  return file;
});

const saveSentFile = Effect.fn("ClaudeCloudFilesTest.saveSentFile")(function* (threadId: string) {
  const path = yield* Path.Path;
  return yield* writeFile(path.join(yield* threadFiles(threadId), FILE_UUIDS[0], "clip.mp4"));
});

const link = (target: string, linkPath: string) =>
  Effect.promise(() => NodeFSP.symlink(target, linkPath, "junction"));

describe("sweepClaudeCloudFiles", () => {
  it.effect(
    "removes the folders of deleted and unknown threads and keeps live and archived ones",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const live = ThreadId.make("thread:live");
        const archived = ThreadId.make("thread:archived");
        const deleted = ThreadId.make("thread:deleted");
        yield* writeThread(live, "live");
        yield* writeThread(archived, "archived");
        yield* writeThread(deleted, "deleted");
        const liveFile = yield* saveSentFile(live);
        const archivedFile = yield* saveSentFile(archived);
        yield* saveSentFile(deleted);
        yield* saveSentFile("thread:never-existed");

        yield* sweepClaudeCloudFiles;

        assert.isTrue(yield* fileSystem.exists(liveFile));
        assert.isTrue(yield* fileSystem.exists(archivedFile));
        assert.isFalse(yield* fileSystem.exists(yield* threadFiles(deleted)));
        assert.isFalse(yield* fileSystem.exists(yield* threadFiles("thread:never-existed")));
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps a deleted thread's files while a live fork, or a fork of one, shows them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const source = ThreadId.make("thread:source");
      const fork = ThreadId.make("thread:fork");
      const forkOfFork = ThreadId.make("thread:fork-of-fork");
      yield* writeThread(source, "deleted");
      yield* writeThread(fork, "deleted", source);
      yield* writeThread(forkOfFork, "live", fork);
      const sourceFile = yield* saveSentFile(source);
      const forkFile = yield* saveSentFile(fork);

      yield* sweepClaudeCloudFiles;

      assert.isTrue(yield* fileSystem.exists(sourceFile));
      assert.isTrue(yield* fileSystem.exists(forkFile));

      yield* deleteThread(forkOfFork, fork);
      yield* sweepClaudeCloudFiles;

      assert.isFalse(yield* fileSystem.exists(yield* threadFiles(source)));
      assert.isFalse(yield* fileSystem.exists(yield* threadFiles(fork)));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps a live thread's folder whose name ends in a dot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dotted = ThreadId.make("thread:x.");
      yield* writeThread(dotted, "live");
      const file = yield* saveSentFile(dotted);

      yield* sweepClaudeCloudFiles;

      assert.isTrue(yield* fileSystem.exists(file));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes downloads a day old that never finished and keeps the rest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* TestClock.setTime(NOW_MS);
      const threadId = ThreadId.make("thread:downloading");
      yield* writeThread(threadId, "live");
      const folder = yield* threadFiles(threadId);
      const abandoned = yield* writeFile(
        path.join(folder, claudeCloudPartialFileName(FILE_UUIDS[0])),
        NOW_MS - 25 * HOUR_MS,
      );
      const downloading = yield* writeFile(
        path.join(folder, claudeCloudPartialFileName(FILE_UUIDS[1])),
        NOW_MS - HOUR_MS,
      );
      // Claude can send a file that is itself a partial download from somewhere else,
      // and earlier builds saved a long name cut down to one starting with a dot.
      const sentParts = [
        yield* writeFile(path.join(folder, FILE_UUIDS[2], "video.mp4.part"), NOW_MS - 25 * HOUR_MS),
        yield* writeFile(
          path.join(folder, FILE_UUIDS[3], `.${"y".repeat(114)}.part`),
          NOW_MS - 25 * HOUR_MS,
        ),
      ];

      yield* sweepClaudeCloudFiles;

      assert.isFalse(yield* fileSystem.exists(abandoned));
      assert.isTrue(yield* fileSystem.exists(downloading));
      for (const sentPart of sentParts) assert.isTrue(yield* fileSystem.exists(sentPart));

      yield* TestClock.adjust("24 hours");
      yield* sweepClaudeCloudFiles;
      assert.isFalse(yield* fileSystem.exists(downloading));
      for (const sentPart of sentParts) assert.isTrue(yield* fileSystem.exists(sentPart));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never reaches through a link out of the files folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* TestClock.setTime(NOW_MS);
      const outside = path.join(config.stateDir, "outside");
      const outsideFile = yield* writeFile(path.join(outside, "keep.txt"));
      const outsidePartial = yield* writeFile(
        path.join(outside, claudeCloudPartialFileName(FILE_UUIDS[0])),
        NOW_MS - 25 * HOUR_MS,
      );
      const live = ThreadId.make("thread:live");
      const deleted = ThreadId.make("thread:deleted");
      yield* writeThread(live, "live");
      yield* writeThread(deleted, "deleted");
      yield* saveSentFile(live);
      yield* saveSentFile(deleted);
      // A link where an unknown thread's folder would be, and links inside a live
      // and a deleted thread's folders.
      const unknownFolder = yield* threadFiles("thread:never-existed");
      yield* link(outside, unknownFolder);
      yield* link(outside, path.join(yield* threadFiles(live), FILE_UUIDS[1]));
      yield* link(outside, path.join(yield* threadFiles(deleted), FILE_UUIDS[1]));

      yield* sweepClaudeCloudFiles;

      assert.isFalse(yield* fileSystem.exists(yield* threadFiles(deleted)));
      assert.isTrue(yield* fileSystem.exists(unknownFolder));
      assert.isTrue(yield* fileSystem.exists(outsideFile));
      assert.isTrue(yield* fileSystem.exists(outsidePartial));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("removeClaudeCloudThreadFiles", () => {
  it.effect("keeps a deleted thread's files while a live fork shows them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const source = ThreadId.make("thread:source");
      const fork = ThreadId.make("thread:fork");
      yield* writeThread(source, "deleted");
      yield* writeThread(fork, "live", source);
      const sourceFile = yield* saveSentFile(source);

      yield* removeClaudeCloudThreadFiles(source);
      assert.isTrue(yield* fileSystem.exists(sourceFile));

      yield* deleteThread(fork, source);
      yield* removeClaudeCloudThreadFiles(fork);
      yield* sweepClaudeCloudFiles;
      assert.isFalse(yield* fileSystem.exists(yield* threadFiles(source)));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("leaves the folder of a thread whose id differs only in case or a trailing dot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const live = ThreadId.make("thread:live");
      yield* writeThread(live, "live");
      const file = yield* saveSentFile(live);

      // Windows opens "thread%3ALIVE" as the folder "thread%3Alive".
      for (const threadId of ["THREAD:LIVE", "thread:live."]) {
        yield* removeClaudeCloudThreadFiles(threadId);
      }

      assert.isTrue(yield* fileSystem.exists(file));
    }).pipe(Effect.provide(layerTest)),
  );
});
