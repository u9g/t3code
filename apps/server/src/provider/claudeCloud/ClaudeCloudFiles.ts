// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's FileSystem has no lstat, and its stat follows links.
import * as NodeFSP from "node:fs/promises";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";

// Downloads time out after minutes, so a partial this old was cut short by a crash.
const PARTIAL_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PARTIAL_FILE_SUFFIX = ".part";

/** Where files Claude Cloud sessions send the user are saved, one folder per thread. */
export const claudeCloudFilesDir = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(stateDir, "claude-cloud-files");
});

/**
 * The name of a thread's folder in `claudeCloudFilesDir`, or null when the id
 * can't name a folder of its own. Ids may hold ":", which Windows rejects in
 * names, so they are percent-encoded. Dots survive that, and "." and ".." would
 * name the files folder itself or its parent.
 */
export const claudeCloudThreadFolder = (threadId: string): string | null => {
  const name = encodeURIComponent(threadId);
  return name === "" || name === "." || name === ".." ? null : name;
};

/**
 * Where a download is written, in its thread's folder, until it completes and
 * moves into its file's folder. Saved files are always a folder deeper, so a
 * partial can't be mistaken for a sent file that is itself named "*.part".
 */
export const claudeCloudPartialFileName = (fileUuid: string) =>
  `${fileUuid.toLowerCase()}${PARTIAL_FILE_SUFFIX}`;

// A fork shows its source's history from the source's own rows, sent files
// included, so a deleted thread's files stay while a live thread was forked from
// it, directly or through other forks.
const threadsShowingFiles = (sql: SqlClient.SqlClient) => sql`
  WITH RECURSIVE shown(thread_id) AS (
    SELECT thread_id
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
    UNION
    SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId')
    FROM orchestration_v2_projection_threads AS thread
    JOIN shown ON shown.thread_id = thread.thread_id
    WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
  )
`;

// A link, including a Windows junction, is neither a directory nor a file to
// lstat, so the sweep never reaches through one out of the files folder.
const lstat = (target: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(target)).pipe(Effect.option);

/**
 * Removes a deleted thread's downloads, unless a live fork still shows them; the
 * sweep removes those once the last such fork is deleted.
 */
export const removeClaudeCloudThreadFiles = Effect.fn("ClaudeCloudFiles.removeThreadFiles")(
  function* (threadId: string) {
    const folder = claudeCloudThreadFolder(threadId);
    // Downloads refuse such an id too, so it owns no folder; the path it would give is
    // the files folder itself or its parent.
    if (folder === null) {
      return yield* Effect.logWarning("Skipped provider file cleanup for an unusable thread id", {
        threadId,
      });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* claudeCloudFilesDir;
    if (!(yield* fileSystem.exists(root))) return;
    // Windows opens a folder by its short 8.3 name or in any letter case, so a path
    // can name another thread's folder; only a folder listed under this exact name
    // is the thread's own.
    if (!(yield* fileSystem.readDirectory(root)).includes(folder)) return;
    const shown = yield* sql`
      ${threadsShowingFiles(sql)}
      SELECT 1 FROM shown WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(NodeSqliteClient.readOnly);
    if (shown.length > 0) return;
    yield* fileSystem.remove(path.join(root, folder), { recursive: true, force: true });
  },
);

/**
 * Removes what thread deletion misses: folders of threads deleted before it
 * removed downloads or while a fork showed them, folders a download recreated
 * after its thread was deleted, folders no thread owns, and downloads a crash
 * cut short.
 */
export const sweepClaudeCloudFiles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* claudeCloudFilesDir;
  if (!(yield* fileSystem.exists(root))) return;
  const now = yield* Clock.currentTimeMillis;
  const folders: Array<string> = [];
  for (const name of yield* fileSystem.readDirectory(root)) {
    const stats = yield* lstat(path.join(root, name));
    if (Option.isSome(stats) && stats.value.isDirectory()) folders.push(name);
  }
  if (folders.length === 0) return;
  // Read after listing: a thread exists before its folder does, so a thread
  // created during the sweep can't lose a folder the listing saw.
  const rows = yield* sql<{ readonly threadId: string }>`
    ${threadsShowingFiles(sql)}
    SELECT thread_id AS "threadId" FROM shown
  `.pipe(NodeSqliteClient.readOnly);
  const liveFolders = new Set(rows.flatMap((row) => claudeCloudThreadFolder(row.threadId) ?? []));

  const remove = (target: string, options?: { readonly recursive: boolean }) =>
    fileSystem.remove(target, options).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not remove Claude Cloud files", {
          path: path.relative(root, target),
          error,
        }).pipe(Effect.as(false)),
      ),
    );
  let removedFolders = 0;
  let removedPartials = 0;
  const removeStalePartials = Effect.fnUntraced(function* (folder: string) {
    const names = yield* fileSystem
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (!name.endsWith(PARTIAL_FILE_SUFFIX)) continue;
      const target = path.join(folder, name);
      const stats = yield* lstat(target);
      if (
        Option.isSome(stats) &&
        stats.value.isFile() &&
        stats.value.mtimeMs < now - PARTIAL_FILE_MAX_AGE_MS &&
        (yield* remove(target))
      ) {
        removedPartials++;
      }
    }
  });
  for (const name of folders) {
    const folder = path.join(root, name);
    if (liveFolders.has(name)) {
      yield* removeStalePartials(folder);
      continue;
    }
    // Node's recursive rm unlinks a link it meets instead of descending into it.
    if (yield* remove(folder, { recursive: true })) removedFolders++;
  }
  if (removedFolders > 0 || removedPartials > 0) {
    yield* Effect.logInfo("Removed leftover Claude Cloud files", {
      folders: removedFolders,
      partialFiles: removedPartials,
    });
  }
});
