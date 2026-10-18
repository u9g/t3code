import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ClaudeCloudCredentials from "./ClaudeCloudCredentials.ts";

const TOKEN = "sk-ant-oat-test-token";
const MINUTE = 60_000;
const SESSIONS_SCOPE = "user:sessions:claude_code";

const oauth = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN,
      refreshToken: "sk-ant-ort-never-used",
      expiresAt: 60 * MINUTE,
      scopes: ["user:inference", SESSIONS_SCOPE],
      subscriptionType: "max",
      ...overrides,
    },
    mcpOAuth: {},
  });

const makeHome = (credentials: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-" });
    if (credentials !== undefined) {
      yield* fileSystem.writeFileString(path.join(configDir, ".credentials.json"), credentials);
    }
    const accountConfigPath = path.join(configDir, ".claude.json");
    yield* fileSystem.writeFileString(
      accountConfigPath,
      JSON.stringify({ oauthAccount: { organizationUuid: "org-1", emailAddress: "a@b.c" } }),
    );
    return {
      configDir,
      accountConfigPath,
      keychainService: "Claude Code-credentials",
    } satisfies ClaudeCloudCredentials.ClaudeCloudLoginLocation;
  });

const readOn = (
  platform: NodeJS.Platform,
  location: ClaudeCloudCredentials.ClaudeCloudLoginLocation,
) =>
  ClaudeCloudCredentials.readClaudeCloudLogin(location).pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.result,
  );

const failureReason = (
  result: Result.Result<unknown, ClaudeCloudCredentials.ClaudeCloudCredentialsError>,
) => (Result.isFailure(result) ? result.failure.reason : undefined);

const fakeSecurity = (result: { readonly stdout: string; readonly exitCode: number }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      calls.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
      const stdout = Stream.make(new TextEncoder().encode(result.stdout));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
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
  return { calls, spawner };
};

it.layer(NodeServices.layer)("ClaudeCloudCredentials", (it) => {
  describe("resolveClaudeCloudLoginLocation", () => {
    it.effect(
      "uses ~/.claude and ~/.claude.json with the unsuffixed Keychain item by default",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = path.resolve("/home/tester");
          const location = yield* ClaudeCloudCredentials.resolveClaudeCloudLoginLocation(
            { homePath: "" },
            {},
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
          expect(location).toEqual({
            configDir: path.join(home, ".claude"),
            accountConfigPath: path.join(home, ".claude.json"),
            keychainService: "Claude Code-credentials",
          });
        }),
    );

    it.effect("follows CLAUDE_CONFIG_DIR and hashes it as given, like the CLI", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const location = yield* ClaudeCloudCredentials.resolveClaudeCloudLoginLocation(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
        );
        expect(location).toEqual({
          configDir: path.resolve("/tmp/claude-work"),
          accountConfigPath: path.join(path.resolve("/tmp/claude-work"), ".claude.json"),
          // sha256("/tmp/claude-work").slice(0, 8)
          keychainService: "Claude Code-credentials-bfc1769a",
        });
      }),
    );

    it.effect("treats a configured homePath as the CLI's CLAUDE_CONFIG_DIR", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configured = path.resolve("/tmp/claude-configured");
        const location = yield* ClaudeCloudCredentials.resolveClaudeCloudLoginLocation(
          { homePath: configured },
          { CLAUDE_CONFIG_DIR: "/tmp/ignored" },
        );
        const asInherited = yield* ClaudeCloudCredentials.resolveClaudeCloudLoginLocation(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configured },
        );
        expect(location).toEqual(asInherited);
        expect(location.configDir).toBe(configured);
        expect(location.accountConfigPath).toBe(path.join(configured, ".claude.json"));
        expect(location.keychainService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
      }),
    );
  });

  describe("readClaudeCloudLogin", () => {
    it.effect("reads the file login with the organization and keeps the token redacted", () =>
      Effect.gen(function* () {
        const location = yield* makeHome(oauth());
        const result = yield* readOn("linux", location);
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        const login = result.success;
        expect(Redacted.value(login.accessToken)).toBe(TOKEN);
        expect(login).toMatchObject({
          expiresAt: 60 * MINUTE,
          scopes: ["user:inference", SESSIONS_SCOPE],
          subscriptionType: "max",
          organizationUuid: "org-1",
        });
        expect(`${String(login.accessToken)} ${JSON.stringify(login)}`).not.toContain(TOKEN);
      }),
    );

    it.effect("reports a missing, incomplete or unparsable login", () =>
      Effect.gen(function* () {
        expect(failureReason(yield* readOn("linux", yield* makeHome(undefined)))).toBe("missing");
        expect(
          failureReason(yield* readOn("linux", yield* makeHome(oauth({ accessToken: "  " })))),
        ).toBe("missing");
        expect(failureReason(yield* readOn("linux", yield* makeHome('{"mcpOAuth":{}}')))).toBe(
          "missing",
        );
        expect(failureReason(yield* readOn("linux", yield* makeHome("{not json")))).toBe(
          "unreadable",
        );
        const mismatched = yield* readOn("linux", yield* makeHome(oauth({ expiresAt: "soon" })));
        expect(failureReason(mismatched)).toBe("unreadable");
        if (Result.isFailure(mismatched)) {
          const failure = mismatched.failure;
          expect(`${JSON.stringify(failure)} ${String(failure)} ${failure.stack}`).not.toContain(
            "sk-ant",
          );
        }
      }),
    );

    it.effect("requires the cloud sessions scope", () =>
      Effect.gen(function* () {
        for (const scopes of [["user:inference"], null]) {
          const location = yield* makeHome(oauth({ scopes }));
          expect(failureReason(yield* readOn("linux", location))).toBe("no_sessions_scope");
        }
      }),
    );

    it.effect("stops using a token within five minutes of its expiry", () =>
      Effect.gen(function* () {
        const location = yield* makeHome(oauth({ expiresAt: 10 * MINUTE }));
        yield* TestClock.setTime(4 * MINUTE);
        expect((yield* readOn("linux", location))._tag).toBe("Success");
        yield* TestClock.setTime(5 * MINUTE);
        expect(failureReason(yield* readOn("linux", location))).toBe("expired");
        const noExpiry = yield* makeHome(oauth({ expiresAt: null }));
        expect((yield* readOn("linux", noExpiry))._tag).toBe("Success");
      }),
    );

    it.effect("prefers the macOS Keychain item and falls back to the file", () =>
      Effect.gen(function* () {
        const location = yield* makeHome(oauth({ subscriptionType: "file" }));
        const keychain = fakeSecurity({
          stdout: `${oauth({ subscriptionType: "pro" })}\n`,
          exitCode: 0,
        });
        const fromKeychain = yield* readOn("darwin", {
          ...location,
          keychainService: "Claude Code-credentials-abcd1234",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, keychain.spawner));
        expect(fromKeychain).toMatchObject({
          _tag: "Success",
          success: { subscriptionType: "pro" },
        });
        expect(keychain.calls).toEqual([
          [
            "find-generic-password",
            "-a",
            "claude-code-user",
            "-w",
            "-s",
            "Claude Code-credentials-abcd1234",
          ],
        ]);

        const absent = fakeSecurity({ stdout: "", exitCode: 44 });
        const fromFile = yield* readOn("darwin", location).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, absent.spawner),
        );
        expect(fromFile).toMatchObject({ _tag: "Success", success: { subscriptionType: "file" } });
      }),
    );

    it.effect("reports an unreadable Keychain rather than a missing login", () =>
      Effect.gen(function* () {
        const locked = fakeSecurity({ stdout: "", exitCode: 36 });
        const result = yield* readOn("darwin", yield* makeHome(undefined)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, locked.spawner),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unreadable", store: "keychain" },
        });
      }),
    );

    it.effect("never touches the Keychain off macOS", () =>
      Effect.gen(function* () {
        const keychain = fakeSecurity({ stdout: oauth(), exitCode: 0 });
        const result = yield* readOn("linux", yield* makeHome(oauth())).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, keychain.spawner),
        );
        expect(result._tag).toBe("Success");
        expect(keychain.calls).toEqual([]);
      }),
    );
  });
});
