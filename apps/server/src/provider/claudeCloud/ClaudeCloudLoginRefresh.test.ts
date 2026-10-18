import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { ClaudeCloudLoginLocation } from "./ClaudeCloudCredentials.ts";
import { makeRefreshingClaudeCloudLogin } from "./ClaudeCloudLoginRefresh.ts";

const MINUTE = 60_000;
const EXPIRED_TOKEN = "sk-ant-oat-expired";
const FRESH_TOKEN = "sk-ant-oat-fresh";

const credentials = (accessToken: string, expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "sk-ant-ort-never-used",
      expiresAt,
      scopes: ["user:inference", "user:sessions:claude_code"],
      subscriptionType: "max",
    },
  });

// The test clock starts at 0, so this token is inside the five-minute margin.
const EXPIRED = credentials(EXPIRED_TOKEN, 2 * MINUTE);
const FRESH = credentials(FRESH_TOKEN, 60 * MINUTE);

const makeHome = (stored: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-" });
    const credentialsPath = path.join(configDir, ".credentials.json");
    if (stored !== undefined) yield* fileSystem.writeFileString(credentialsPath, stored);
    return {
      credentialsPath,
      location: {
        configDir,
        accountConfigPath: path.join(configDir, ".claude.json"),
        keychainService: "Claude Code-credentials",
      } satisfies ClaudeCloudLoginLocation,
    };
  });

interface CliRun {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly stdin: unknown;
  readonly env: Record<string, string | undefined> | undefined;
}

/** Stands in for `claude`; `refresh` plays the CLI rewriting its store. */
const fakeCli = (options: {
  readonly refresh?: Effect.Effect<void>;
  readonly spawnFailure?: PlatformError.PlatformError;
}) => {
  const runs: Array<CliRun> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("unexpected pipeline");
      runs.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        stdin: command.options.stdin,
        env: command.options.env,
      });
      if (options.spawnFailure) return yield* options.spawnFailure;
      if (options.refresh) yield* options.refresh;
      const stdout = Stream.make(new TextEncoder().encode('{"ok":false}\n'));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { runs, spawner };
};

const makeLogin = (
  location: ClaudeCloudLoginLocation,
  cli: ReturnType<typeof fakeCli>,
  environment: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: location.configDir },
) =>
  makeRefreshingClaudeCloudLogin({ location, binaryPath: "claude", environment }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
  );

const tokenOf = <E>(result: Result.Result<{ readonly accessToken: Redacted.Redacted }, E>) =>
  Result.isSuccess(result) ? Redacted.value(result.success.accessToken) : undefined;

const failureReasonOf = <A>(result: Result.Result<A, { readonly reason: string }>) =>
  Result.isFailure(result) ? result.failure.reason : undefined;

it.layer(NodeServices.layer)("makeRefreshingClaudeCloudLogin", (it) => {
  describe("with a usable login", () => {
    it.effect("reads it without starting the CLI", () =>
      Effect.gen(function* () {
        const home = yield* makeHome(FRESH);
        const cli = fakeCli({});
        const login = yield* makeLogin(home.location, cli);
        expect(tokenOf(yield* Effect.result(login))).toBe(FRESH_TOKEN);
        expect(cli.runs).toEqual([]);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );
  });

  describe("with an expired login", () => {
    it.effect("asks the CLI to refresh it from an empty directory, then reads it again", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(EXPIRED);
        const cli = fakeCli({
          refresh: fileSystem.writeFileString(home.credentialsPath, FRESH).pipe(Effect.orDie),
        });
        const environment = { CLAUDE_CONFIG_DIR: home.location.configDir, PATH: "/usr/bin" };
        const login = yield* makeLogin(home.location, cli, environment);

        expect(tokenOf(yield* Effect.result(login))).toBe(FRESH_TOKEN);
        expect(cli.runs).toHaveLength(1);
        const run = cli.runs[0]!;
        expect(run.command).toBe("claude");
        expect(run.args).toEqual([
          "-p",
          ".",
          "--cloud",
          "cse_01111111111111111111111111",
          "--output-format",
          "json",
        ]);
        expect(run.stdin).toBe("ignore");
        expect(run.env).toEqual(environment);
        expect(run.cwd).toBeDefined();
        expect(run.cwd).not.toBe(home.location.configDir);
        // The scratch directory goes away with the run.
        expect(yield* fileSystem.exists(run.cwd!)).toBe(false);
        // The store is the CLI's to write; T3 only read it.
        expect(yield* fileSystem.readFileString(home.credentialsPath)).toBe(FRESH);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    it.effect("reads the refreshed login when its scratch directory cannot be removed", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(EXPIRED);
        const cli = fakeCli({
          refresh: fileSystem.writeFileString(home.credentialsPath, FRESH).pipe(Effect.orDie),
        });
        // A CLI that outlived its timeout keeps the directory busy, and the
        // platform's scoped temp directory dies when its removal fails.
        const busy = PlatformError.systemError({
          _tag: "Busy",
          module: "FileSystem",
          method: "remove",
          description: "EBUSY: resource busy or locked",
        });
        const lockedScratch: FileSystem.FileSystem = {
          ...fileSystem,
          remove: () => Effect.fail(busy),
          makeTempDirectoryScoped: (options) =>
            Effect.acquireRelease(fileSystem.makeTempDirectory(options), () => Effect.die(busy)),
        };
        const login = yield* makeLogin(home.location, cli).pipe(
          Effect.provideService(FileSystem.FileSystem, lockedScratch),
        );

        expect(tokenOf(yield* Effect.result(login))).toBe(FRESH_TOKEN);
        const scratch = cli.runs[0]?.cwd;
        expect(scratch).toBeDefined();
        if (scratch !== undefined) yield* fileSystem.remove(scratch, { recursive: true });
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    it.effect("still reports the expiry when the CLI did not refresh it", () =>
      Effect.gen(function* () {
        const home = yield* makeHome(EXPIRED);
        const cli = fakeCli({});
        const login = yield* makeLogin(home.location, cli);
        expect(failureReasonOf(yield* Effect.result(login))).toBe("expired");
        expect(cli.runs).toHaveLength(1);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    it.effect("still reports the expiry when the CLI cannot start", () =>
      Effect.gen(function* () {
        const home = yield* makeHome(EXPIRED);
        const cli = fakeCli({
          spawnFailure: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "spawn claude ENOENT",
          }),
        });
        const login = yield* makeLogin(home.location, cli);
        expect(failureReasonOf(yield* Effect.result(login))).toBe("expired");
        expect(cli.runs).toHaveLength(1);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    it.effect("runs the CLI once for requests that arrive together", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(EXPIRED);
        const cli = fakeCli({
          refresh: fileSystem.writeFileString(home.credentialsPath, FRESH).pipe(Effect.orDie),
        });
        const login = yield* makeLogin(home.location, cli);
        const results = yield* Effect.forEach([login, login, login], Effect.result, {
          concurrency: "unbounded",
        });
        expect(results.map(tokenOf)).toEqual([FRESH_TOKEN, FRESH_TOKEN, FRESH_TOKEN]);
        expect(cli.runs).toHaveLength(1);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );
  });

  it.effect("does not start the CLI for a login that refreshing cannot fix", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(undefined);
      const cli = fakeCli({});
      const login = yield* makeLogin(home.location, cli);
      expect(failureReasonOf(yield* Effect.result(login))).toBe("missing");
      expect(cli.runs).toEqual([]);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});
