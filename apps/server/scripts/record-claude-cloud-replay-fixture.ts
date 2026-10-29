import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import packageJson from "../package.json" with { type: "json" };
import { ClaudeAgentSdkQueryRunner } from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  CLAUDE_CLOUD_PROVIDER,
  ClaudeCloudOrchestratorReplayHarness,
  layerClaudeCloudProviderAdapterRegistry,
  recordClaudeAgentSdkQueryRunner,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { makeClaudeCloudQueryRunner } from "../src/orchestration-v2/Adapters/ClaudeCloudQueryRunner.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ClaudeCloudApi from "../src/provider/claudeCloud/ClaudeCloudApi.ts";
import { resolveClaudeCloudLoginLocation } from "../src/provider/claudeCloud/ClaudeCloudCredentials.ts";
import { makeRefreshingClaudeCloudLogin } from "../src/provider/claudeCloud/ClaudeCloudLoginRefresh.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

/**
 * Records a shared fixture against a real Claude Code cloud session, with the orchestrator and
 * claudeCloud adapter running over the live cloud query runner on the `claude` CLI's login:
 *   node scripts/record-claude-cloud-replay-fixture.ts --scenario simple --repo <clone>
 * `--repo` is a pushed clone the claude.ai account can open on the web. Sessions get archived.
 */

const CLOCK_TICK = Duration.millis(20);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === CLAUDE_CLOUD_PROVIDER);
if (fixture === undefined || variant === undefined) {
  const names = ORCHESTRATOR_REPLAY_FIXTURES.filter((entry) =>
    entry.providers.some((provider) => provider.driver === CLAUDE_CLOUD_PROVIDER),
  ).map((entry) => entry.name);
  throw new Error(`Pass --scenario with a fixture that registers claudeCloud: ${names.join(", ")}`);
}
const repository = readArgValue("--repo");
if (repository === undefined) {
  throw new Error("Pass --repo with a clone of a pushed GitHub repository.");
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Local paths would tie the fixture to this machine. */
function scrubEntries(
  entries: ReadonlyArray<ProviderReplayEntry>,
  localPaths: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<ProviderReplayEntry> {
  const scrubString = (value: string) =>
    localPaths.reduce((text, [path, replacement]) => text.replaceAll(path, replacement), value);
  const scrubValue = (value: unknown): unknown =>
    typeof value === "string"
      ? scrubString(value)
      : Array.isArray(value)
        ? value.map(scrubValue)
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [key, scrubValue(entry)]),
            )
          : value;
  return entries.map((entry) =>
    entry.type === "runtime_exit" ? entry : { ...entry, frame: scrubValue(entry.frame) },
  );
}

/** The Claude Code the session's worker runs, from its `init`; a turn cancelled before it ran has none. */
function workerVersion(entries: ReadonlyArray<ProviderReplayEntry>): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "emit_inbound" || !isRecord(entry.frame)) continue;
    const version = entry.frame.claude_code_version;
    if (entry.frame.subtype === "init" && typeof version === "string") return version;
  }
  return undefined;
}

const decodePackageVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

// The package does not export its package.json, so it is read beside the entry.
const agentSdkVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* path.fromFileUrl(
    new URL(import.meta.resolve("@anthropic-ai/claude-agent-sdk")),
  );
  const manifest = yield* fs.readFileString(path.join(path.dirname(entry), "package.json"));
  return (yield* decodePackageVersion(manifest)).version;
});

/** Recording follows wall time so the cloud runner's own timeouts still elapse. */
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const makeCloudQueryRunner = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const location = yield* resolveClaudeCloudLoginLocation({ homePath: "" }, environment);
  const login = yield* makeRefreshingClaudeCloudLogin({
    location,
    binaryPath: process.env.T3_CLAUDE_BIN ?? "claude",
    environment,
  });
  const api = yield* ClaudeCloudApi.make({ login, version: packageJson.version });
  const queryRunner = yield* makeClaudeCloudQueryRunner({
    api,
    environmentId: process.env.T3_CLAUDE_CLOUD_ENVIRONMENT_ID?.trim() || undefined,
    configDir: location.configDir,
    filesDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-files-" }),
  }).pipe(
    Effect.provide(VcsProcess.layer),
    Effect.provideService(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  );
  return { api, login, queryRunner };
});

// The archive endpoint sits next to the session's event endpoint. The headers
// carry the bearer token, so neither they nor the request are ever printed.
const archiveSession = Effect.fn("recordClaudeCloudReplayFixture.archiveSession")(
  function* (api: ClaudeCloudApi.ClaudeCloudApi, sessionId: string) {
    const transport = yield* api.sessionTransport(sessionId);
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(transport.sendUrl.replace(/\/events$/u, "/archive")).pipe(
        HttpClientRequest.setHeaders(transport.headers),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    yield* Console.log(`Archived ${sessionId}: HTTP ${response.status}`);
  },
  (effect, _api, sessionId) =>
    effect.pipe(
      Effect.catch((error) =>
        Console.error(`Could not archive ${sessionId} (${error._tag}); archive it on claude.ai.`),
      ),
    ),
);

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const fixtureInput = fixture.buildInput();
  const cwd = yield* fs.realPath(repository);
  const { api, login, queryRunner: cloudQueryRunner } = yield* makeCloudQueryRunner;

  const entries: Array<ProviderReplayEntry> = [];
  const createdSessions: Array<string> = [];
  yield* Effect.addFinalizer(() =>
    Effect.forEach(createdSessions, (sessionId) => archiveSession(api, sessionId), {
      discard: true,
    }),
  );
  const recordingQueryRunner = recordClaudeAgentSdkQueryRunner({
    scenario: fixture.name,
    queryRunner: cloudQueryRunner,
    entries,
  });
  const queryRunner = ClaudeAgentSdkQueryRunner.of({
    ...recordingQueryRunner,
    allocateSessionIdFor: Effect.fn("ClaudeAgentSdkQueryRunner.allocateSessionIdFor")(
      function (input) {
        return (
          recordingQueryRunner.allocateSessionIdFor?.(input) ??
          recordingQueryRunner.allocateSessionId
        ).pipe(
          Effect.tap((sessionId) =>
            Effect.sync(() => {
              createdSessions.push(sessionId);
            }).pipe(Effect.andThen(Console.log(`Created ${sessionId}`))),
          ),
        );
      },
    ),
  });

  const placeholder: ProviderReplayTranscript = {
    provider: CLAUDE_CLOUD_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "unknown",
    scenario: fixture.name,
    entries: [],
  };
  const materializeInput = materializeFixtureInput({
    scenario: fixture.name,
    fixtureInput,
    driver: variant.driver,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeInput;
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/claudeCloud:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd },
      },
      {
        driver: CLAUDE_CLOUD_PROVIDER,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          layerClaudeCloudProviderAdapterRegistry({
            scenario: fixture.name,
            queryRunner: Layer.succeed(ClaudeAgentSdkQueryRunner, queryRunner),
          }),
      },
      continuationOptions,
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const home = yield* HostProcess.HomeDirectory;
  const scrubbed = scrubEntries(entries, [
    [cwd, "<workspace>"],
    [cwd.replaceAll("\\", "/"), "<workspace>"],
    [home, "~"],
    [home.replaceAll("\\", "/"), "~"],
  ]);
  const worker = workerVersion(scrubbed);
  const transcript = {
    ...placeholder,
    version: yield* agentSdkVersion,
    metadata: {
      generatedBy: "record-claude-cloud-replay-fixture",
      model: variant.modelSelection.model,
      ...(worker === undefined ? {} : { claudeCodeVersion: worker }),
      ...(createdSessions[0] === undefined ? {} : { nativeSessionId: createdSessions[0] }),
    },
    entries: scrubbed,
  } satisfies ProviderReplayTranscript;
  const encoded = encodeTranscriptNdjson(transcript);
  const { accessToken } = yield* login;
  // Says which check failed, never what matched.
  const leaked = encoded.includes(Redacted.value(accessToken))
    ? "the claude.ai access token"
    : /sk-ant-[a-z]+\d*-/u.test(encoded)
      ? "an Anthropic key or token"
      : undefined;
  if (leaked !== undefined) {
    return yield* Effect.die(new Error(`The recording holds ${leaked}; nothing was written.`));
  }
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encoded);
  yield* Console.log(`Wrote ${transcript.entries.length} replay entries to ${outputPath}`);

  // Written first: a recording costs a cloud session, and an assertion that
  // does not fit it is fixed in the fixture, not by recording again.
  yield* Effect.gen(function* () {
    const replayWorkspace = yield* checkpointWorkspace(fixture.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeInput;
    const replayed = yield* ClaudeCloudOrchestratorReplayHarness.decodeTranscript(transcript);
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/claudeCloud:verify`,
        transcript: replayed,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: replayWorkspace },
      },
      ClaudeCloudOrchestratorReplayHarness,
      continuationOptions,
    );
    variant.assertOutput(result, replayed);
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);
  yield* Console.log(`Replayed ${fixture.name} and its assertions passed.`);
});

await Effect.runPromise(
  record.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
