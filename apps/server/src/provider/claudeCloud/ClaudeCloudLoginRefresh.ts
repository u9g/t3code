import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeCloudLoginLocation, readClaudeCloudLogin } from "./ClaudeCloudCredentials.ts";

// The CLI refreshes an expiring claude.ai login before it looks up a `--cloud`
// session. No session has this well-formed id, so the run then stops at a 404
// with exit code 1, having sent no prompt.
const UNKNOWN_SESSION_ID = `cse_01${"1".repeat(24)}`;
const REFRESH_ARGS = ["-p", ".", "--cloud", UNKNOWN_SESSION_ID, "--output-format", "json"];
const REFRESH_EXIT_CODE = 1;
const REFRESH_TIMEOUT = "30 seconds";

/**
 * Reads the claude CLI's login before each cloud request. When it has expired,
 * the CLI is asked to refresh it and the store is read once more. T3 never
 * refreshes the token itself: refresh tokens rotate, so a second refresher
 * would sign the CLI out.
 */
export const makeRefreshingClaudeCloudLogin = Effect.fn("makeRefreshingClaudeCloudLogin")(
  function* (input: {
    readonly location: ClaudeCloudLoginLocation;
    readonly binaryPath: string;
    /** The CLI's environment; carries CLAUDE_CONFIG_DIR for a configured config dir. */
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    // Requests that find the same expired token share one CLI run.
    const refreshLock = yield* Semaphore.make(1);
    const read = readClaudeCloudLogin(input.location).pipe(Effect.provideContext(context));

    const askCliToRefresh = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // An empty directory keeps the CLI away from a project's settings and hooks.
      // Removing it can fail (on Windows a CLI process that outlived the timeout
      // still holds it), and the scoped variant turns that into a defect the
      // best-effort catch below cannot see.
      const cwd = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ prefix: "t3-claude-cloud-refresh-" }),
        (directory) =>
          fileSystem.remove(directory, { recursive: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Claude Cloud could not remove the login refresh directory.", {
                reason: error.reason._tag,
              }),
            ),
          ),
      );
      const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, REFRESH_ARGS, {
        env: input.environment,
      });
      return yield* spawnAndCollect(
        input.binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd,
          env: input.environment,
          shell: spawnCommand.shell,
          stdin: "ignore",
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeout(REFRESH_TIMEOUT),
      Effect.flatMap((result) =>
        result.code === REFRESH_EXIT_CODE
          ? Effect.void
          : Effect.logWarning("The claude CLI exited unexpectedly while refreshing its login.", {
              exitCode: result.code,
            }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Claude Cloud could not run the claude CLI to refresh its login.", {
          errorTag: error._tag,
        }),
      ),
      Effect.provideContext(context),
    );

    const refreshThenRead = refreshLock.withPermit(
      // A request that waited on the lock finds the login another one refreshed.
      read.pipe(
        Effect.catchIf(
          (error) => error.reason === "expired",
          () => askCliToRefresh.pipe(Effect.andThen(read)),
        ),
      ),
    );

    return read.pipe(
      Effect.catchIf(
        (error) => error.reason === "expired",
        () => refreshThenRead,
      ),
    );
  },
);
