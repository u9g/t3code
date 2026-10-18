import type {
  CanUseTool,
  EffortLevel,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BrowserQueryOptions, Query } from "@anthropic-ai/claude-agent-sdk/browser";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type ClaudeCloudApi,
  type ClaudeCloudApiError,
  type ClaudeCloudCreateSessionInput,
  type ClaudeCloudFileContent,
  ClaudeCloudHttpError,
  ClaudeCloudNotFoundError,
  type ClaudeCloudSession,
  type ClaudeCloudSessionInitError,
} from "../../provider/claudeCloud/ClaudeCloudApi.ts";
import { ClaudeCloudCredentialsError } from "../../provider/claudeCloud/ClaudeCloudCredentials.ts";
import { claudeCloudPartialFileName } from "../../provider/claudeCloud/ClaudeCloudFiles.ts";
import { makeFakeGitHubRemote } from "../../provider/claudeCloud/ClaudeCloudRepository.testkit.ts";
import {
  type ChooseClaudeCloudRepository,
  type ClaudeCloudRepositoryChoice,
  ClaudeCloudRepositoryChoiceError,
  type ClaudeCloudRepositoryChoiceRequest,
} from "../../provider/claudeCloud/ClaudeCloudRepositoryChoice.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as ClaudeCloudQueryRunner from "./ClaudeCloudQueryRunner.ts";

const layer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const SESSION_ID = "cse_01Created";
const WEB_URL = "https://claude.ai/code/session_01Created";
const THREAD_ID = ThreadId.make("thread-claude-cloud");
const PROVIDER_SESSION_ID = ProviderSessionId.make("provider-session-claude-cloud");
const OPUS_XHIGH = {
  instanceId: ProviderInstanceId.make("claudeCloud"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
} satisfies ModelSelection;
const MINUTE = 60_000;

const frame = (value: Record<string, unknown>) => value as unknown as SDKMessage;

/** A session with a worker attached, unless told otherwise. */
const cloudSession = (overrides: Partial<ClaudeCloudSession> = {}): ClaudeCloudSession => ({
  id: SESSION_ID,
  status: "active",
  webUrl: WEB_URL,
  connectionStatus: "connected",
  workerStatus: "idle",
  environmentKind: "anthropic_cloud",
  lastInitError: null,
  ...overrides,
});
/** A session whose container is still booting. */
const BOOTING = {
  connectionStatus: "disconnected",
  workerStatus: "WORKER_STATUS_UNSPECIFIED",
} satisfies Partial<ClaudeCloudSession>;
/** A session whose container the cloud stopped after it sat idle. */
const STOPPED = {
  connectionStatus: "disconnected",
  workerStatus: "idle",
} satisfies Partial<ClaudeCloudSession>;
/** What the cloud reports when the requested branch is not on GitHub. */
const BRANCH_NOT_FOUND: ClaudeCloudSessionInitError = {
  kind: "source_processing",
  type: "ref_not_found",
  recoverable: false,
  at: 0,
};

const prompt = (uuid: NonNullable<SDKUserMessage["uuid"]>, content = "Hello"): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  uuid,
});
const FIRST_UUID = "11111111-1111-4111-8111-111111111111";
const SECOND_UUID = "33333333-3333-4333-8333-333333333333";
const FIRST_PROMPT = prompt(FIRST_UUID);
const SECOND_PROMPT = prompt(SECOND_UUID, "And then this");

const sseError = (code: number) =>
  Object.assign(new Error(`SSE connect failed: HTTP ${code}`), { name: "SSEHttpError", code });

type FakeControl =
  | "initialize"
  | "setModel"
  | "setPermissionMode"
  | "applyFlagSettings"
  | "stopTask"
  | "backgroundTasks"
  | "interrupt";

interface Envelope {
  readonly event_id: string;
  readonly sequence_num: number;
  readonly source?: string;
}

interface FakeSdkState {
  readonly envelopes: WeakMap<SDKMessage, Envelope>;
  readonly respond: (method: FakeControl) => Promise<unknown>;
}

const until = (ready: () => boolean, waiters: Array<() => void>) =>
  Effect.promise(() =>
    ready()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.push(() => {
            if (ready()) resolve();
          });
        }),
  );

/** Stands in for the SDK's `Query`: frames are pushed in, posts and controls are recorded. */
class FakeQuery {
  readonly controls: Array<{ readonly method: FakeControl; readonly argument?: unknown }> = [];
  /** Prompts this query POSTed. */
  readonly posted: Array<SDKUserMessage> = [];
  closed = false;
  cursor: number | undefined;
  private readonly frames: Array<
    { readonly message: SDKMessage; readonly envelope?: Envelope } | { readonly error: unknown }
  > = [];
  private wake: (() => void) | undefined;
  private readonly postWaiters: Array<() => void> = [];
  readonly options: BrowserQueryOptions;
  private readonly state: FakeSdkState;

  constructor(options: BrowserQueryOptions, state: FakeSdkState) {
    this.options = options;
    this.state = state;
    void this.streamInput();
  }

  // Like the SDK, takes each prompt as soon as it is offered, so one taken by
  // a query that then closes is gone with it.
  private async streamInput() {
    for await (const message of this.options.prompt) {
      if (this.closed) return;
      this.posted.push(message);
      for (const waiter of this.postWaiters) waiter();
    }
  }

  untilPosted(count: number) {
    return until(() => this.posted.length >= count, this.postWaiters);
  }

  push(message: SDKMessage, envelope?: Envelope) {
    this.frames.push(envelope === undefined ? { message } : { message, envelope });
    this.wake?.();
  }

  /** The session storing one of our prompts and streaming it back. */
  echo(message: SDKUserMessage, sequenceNum: number) {
    this.push(frame({ ...message, session_id: "" }), {
      event_id: `e${sequenceNum}`,
      sequence_num: sequenceNum,
      source: "client",
    });
  }

  fail(error: unknown) {
    this.frames.push({ error });
    this.wake?.();
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    for (;;) {
      const next = this.frames.shift();
      if (next !== undefined) {
        if ("error" in next) throw next.error;
        if (next.envelope !== undefined) {
          this.state.envelopes.set(next.message, next.envelope);
          this.cursor = next.envelope.sequence_num;
        }
        return { done: false, value: next.message };
      }
      if (this.closed) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  initializationResult() {
    return this.control("initialize");
  }
  setModel(model?: string) {
    return this.control("setModel", model);
  }
  setPermissionMode(mode: PermissionMode) {
    return this.control("setPermissionMode", mode);
  }
  applyFlagSettings(settings: unknown) {
    return this.control("applyFlagSettings", settings);
  }
  stopTask(taskId: string) {
    return this.control("stopTask", taskId);
  }
  backgroundTasks(toolUseId?: string) {
    return this.control("backgroundTasks", toolUseId);
  }
  interrupt(options?: unknown) {
    return this.control("interrupt", options);
  }

  private control(method: FakeControl, argument?: unknown) {
    this.controls.push(argument === undefined ? { method } : { method, argument });
    return this.state.respond(method);
  }
}

const answerControl = (method: FakeControl): Promise<unknown> =>
  Promise.resolve(
    method === "interrupt" ? { still_queued: [] } : method === "backgroundTasks" ? true : {},
  );

const makeFakeSdk = (respond: (method: FakeControl) => Promise<unknown> = answerControl) => {
  const state: FakeSdkState = { envelopes: new WeakMap(), respond };
  const queries: Array<FakeQuery> = [];
  const byQuery = new WeakMap<object, FakeQuery>();
  const waiters: Array<() => void> = [];
  return {
    queries,
    /** Waits until the runner has opened `count` queries. */
    untilQueries: (count: number) => until(() => queries.length >= count, waiters),
    sdk: {
      query: (options: BrowserQueryOptions) => {
        const fake = new FakeQuery(options, state);
        queries.push(fake);
        byQuery.set(fake, fake);
        for (const waiter of waiters) waiter();
        return fake as unknown as Query;
      },
      getCcrEvent: (_query: Query, message: SDKMessage) => state.envelopes.get(message),
      getSseLastSequenceNum: (query: Query) => byQuery.get(query)?.cursor,
    },
  };
};

const makeFakeApi = (
  options: {
    readonly latestSequenceNum?: number;
    readonly session?: (
      sessionId: string,
    ) => Effect.Effect<ClaudeCloudSession, ClaudeCloudApiError>;
    /** Runs before each login read; `count` is 1 for the first. */
    readonly beforeTransport?: (count: number) => Effect.Effect<void, ClaudeCloudCredentialsError>;
    readonly expiresAt?: number;
    readonly downloadFile?: (
      fileUuid: string,
    ) => Effect.Effect<ClaudeCloudFileContent, ClaudeCloudApiError>;
  } = {},
) => {
  const created: Array<ClaudeCloudCreateSessionInput> = [];
  const latestSequenceNumReads: Array<string> = [];
  const sessionReads: Array<string> = [];
  let transports = 0;
  const api: ClaudeCloudApi = {
    listEnvironments: Effect.succeed([
      { id: "env_bridge", kind: "bridge" },
      { id: "env_cloud", kind: "anthropic_cloud" },
    ]),
    createSession: (input) =>
      Effect.sync(() => {
        created.push(input);
        return cloudSession({ ...BOOTING });
      }),
    getSession: (sessionId) =>
      Effect.suspend(() => {
        sessionReads.push(sessionId);
        return options.session?.(sessionId) ?? Effect.succeed(cloudSession({ id: sessionId }));
      }),
    latestSequenceNum: (sessionId) =>
      Effect.sync(() => {
        latestSequenceNumReads.push(sessionId);
        return options.latestSequenceNum ?? 14;
      }),
    downloadFile: (fileUuid) =>
      options.downloadFile?.(fileUuid) ??
      Effect.fail(new ClaudeCloudNotFoundError({ operation: "downloadFile" })),
    sessionTransport: (sessionId) =>
      Effect.suspend(() => {
        transports += 1;
        const count = transports;
        return (options.beforeTransport?.(count) ?? Effect.void).pipe(
          Effect.as({
            sessionId,
            streamUrl: `https://cloud.test/v1/code/sessions/${sessionId}/events/stream`,
            sendUrl: `https://cloud.test/v1/code/sessions/${sessionId}/events`,
            headers: { authorization: `Bearer token-${count}` },
            expiresAt: options.expiresAt ?? null,
          }),
        );
      }),
  };
  return { api, created, latestSequenceNumReads, sessionReads };
};

const makeRunner = (input: {
  readonly api: ClaudeCloudApi;
  readonly sdk: ReturnType<typeof makeFakeSdk>["sdk"];
  readonly environmentId?: string;
  readonly nativeLog?: Array<unknown>;
  readonly filesDir?: string;
  readonly withoutProject?: ClaudeCloudQueryRunner.ClaudeCloudQueryRunnerOptions["withoutProject"];
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-cloud-config-",
    });
    const filesDir =
      input.filesDir ??
      (yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-files-" }));
    const nativeLog = input.nativeLog;
    return yield* ClaudeCloudQueryRunner.makeClaudeCloudQueryRunner({
      api: input.api,
      environmentId: input.environmentId,
      configDir,
      filesDir,
      sdk: input.sdk,
      ...(input.withoutProject === undefined ? {} : { withoutProject: input.withoutProject }),
    }).pipe(
      Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
        native:
          nativeLog === undefined
            ? undefined
            : {
                filePath: "native.log",
                write: (event) =>
                  Effect.sync(() => {
                    nativeLog.push(event);
                  }),
                close: () => Effect.void,
              },
        canonical: undefined,
      }),
    );
  });

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    yield* vcs.run({
      operation: "ClaudeCloudQueryRunner.test",
      command: "git",
      args,
      cwd,
      timeoutMs: 15_000,
    });
  });

/** `main`, pushed to `origin`, with an uncommitted file. */
const makeRepo = (origin = "git@github.com:octo-org/octo-repo.git") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const github = yield* makeFakeGitHubRemote;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-runner-" });
    yield* git(cwd, "init", "-q", "-b", "main");
    yield* git(cwd, "config", "user.email", "test@example.com");
    yield* git(cwd, "config", "user.name", "Test");
    yield* git(cwd, "config", "commit.gpgsign", "false");
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "readme\n");
    yield* git(cwd, "add", "README.md");
    yield* git(cwd, "commit", "-q", "-m", "README");
    yield* git(cwd, "remote", "add", "origin", origin);
    yield* github.serve(cwd);
    yield* git(cwd, "push", "-q", github.path, "HEAD:refs/heads/main");
    yield* git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    yield* git(cwd, "config", "branch.main.remote", "origin");
    yield* git(cwd, "config", "branch.main.merge", "refs/heads/main");
    yield* fileSystem.writeFileString(path.join(cwd, "notes.txt"), "draft\n");
    return cwd;
  });

const allocateInput = (cwd: string | null, title?: string) => ({
  threadId: THREAD_ID,
  ...(title === undefined ? {} : { title }),
  modelSelection: OPUS_XHIGH,
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  }),
});

/**
 * A "No project" scratch folder, which is not a git repository, and a stand-in
 * for the Claude on this machine that chooses its repository.
 */
const makeScratchThread = (
  answer: Effect.Effect<
    ClaudeCloudRepositoryChoice,
    ClaudeCloudRepositoryChoiceError
  > = Effect.succeed({
    repository: "u9g/pnpm",
    branch: "projects-graph-overrides",
    reason: "The pull request's head branch is on the u9g fork.",
  }),
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratchRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-cloud-scratch-",
    });
    const cwd = path.join(scratchRoot, "2026-10-19-rebase-pnpm-14673");
    yield* fileSystem.makeDirectory(cwd);
    const requests: Array<ClaudeCloudRepositoryChoiceRequest> = [];
    const chooseRepository: ChooseClaudeCloudRepository = (request) =>
      Effect.suspend(() => {
        requests.push(request);
        return answer;
      });
    return { cwd, requests, withoutProject: { scratchRoot, chooseRepository } };
  });

const REBASE_MESSAGE = "rebase https://github.com/pnpm/pnpm/pull/14673";

// The cloud runner creates each session for its thread, through allocateSessionIdFor.
const allocate = (
  runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape,
  input: ClaudeAdapterV2.ClaudeAgentSdkSessionAllocateInput,
) =>
  runner.allocateSessionIdFor?.(input) ??
  Effect.die("The cloud runner must create sessions for their thread.");

const openInput = (
  options: {
    readonly resume?: boolean;
    readonly permissionMode?: PermissionMode;
    readonly canUseTool?: CanUseTool;
  } = {},
): ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput => ({
  threadId: THREAD_ID,
  providerSessionId: PROVIDER_SESSION_ID,
  options: ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: OPUS_XHIGH,
    nativeThreadId: SESSION_ID,
    resume: options.resume ?? true,
    cwd: "/workspace",
    permissionMode: options.permissionMode ?? "bypassPermissions",
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:9/mcp" } },
    ...(options.canUseTool === undefined ? {} : { canUseTool: options.canUseTool }),
  }),
});

const controlNames = (query: FakeQuery | undefined) =>
  query?.controls.map((control) => control.method) ?? [];

/** Consumes a session's messages in the background, as the adapter does. */
const consume = (session: ClaudeAdapterV2.ClaudeAgentSdkQuerySession) =>
  Effect.gen(function* () {
    const received: Array<SDKMessage> = [];
    const waiters: Array<() => void> = [];
    const fiber = yield* session.messages.pipe(
      Stream.runForEach((message) =>
        Effect.sync(() => {
          received.push(message);
          for (const waiter of waiters) waiter();
        }),
      ),
      Effect.forkChild,
    );
    return {
      received,
      fiber,
      untilReceived: (message: SDKMessage) => until(() => received.includes(message), waiters),
    };
  });

it.layer(layer)("ClaudeCloudQueryRunner", (it) => {
  describe("allocateSessionId", () => {
    it.effect("creates a cloud session on the project's GitHub repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const fake = makeFakeApi();
        const runner = yield* makeRunner({ api: fake.api, sdk: makeFakeSdk().sdk });

        const sessionId = yield* allocate(runner, allocateInput(cwd, "Fix the flaky test!"));

        assert.equal(sessionId, SESSION_ID);
        assert.deepEqual(fake.created, [
          {
            title: "Fix the flaky test!",
            environmentId: "env_cloud",
            source: { repoUrl: "https://github.com/octo-org/octo-repo", revision: "main" },
            model: "claude-opus-5-5",
            effortLevel: "xhigh",
            permissionMode: "default",
            outcomeBranch: "claude/fix-the-flaky-test",
          },
        ]);
      }),
    );

    it.effect("names an untitled session and honours the configured environment", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const fake = makeFakeApi();
        const runner = yield* makeRunner({
          api: fake.api,
          sdk: makeFakeSdk().sdk,
          environmentId: "env_chosen",
        });

        yield* allocate(runner, {
          ...allocateInput(cwd),
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "plan",
            cwd,
          }),
        });

        assert.deepInclude(fake.created[0], {
          title: "T3 Code thread",
          environmentId: "env_chosen",
          permissionMode: "plan",
          outcomeBranch: "claude/t3-code-thread",
        });
      }),
    );

    it.effect("refuses a thread without a project folder before calling the cloud", () =>
      Effect.gen(function* () {
        const fake = makeFakeApi();
        const runner = yield* makeRunner({ api: fake.api, sdk: makeFakeSdk().sdk });

        const error = yield* allocate(runner, allocateInput(null)).pipe(Effect.flip);

        assert.equal(error.method, "allocateSessionId");
        assert.equal(error.reason, "no_project_folder");
        assert.lengthOf(fake.created, 0);
      }),
    );

    it.effect("tells the user why a project's repository cannot run in the cloud", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo("https://gitlab.com/o/r.git");
        const fake = makeFakeApi();
        const runner = yield* makeRunner({ api: fake.api, sdk: makeFakeSdk().sdk });

        const error = yield* allocate(runner, allocateInput(cwd)).pipe(Effect.flip);

        assert.equal(error.reason, "not_github");
        assert.equal(
          error.message,
          "Claude Cloud works on GitHub repositories, and this project's git remote is not on github.com. Push the project to GitHub first.",
        );
        assert.lengthOf(fake.created, 0);
      }),
    );

    describe("for a thread under No project", () => {
      it.effect("starts the session where Claude on this machine chose from the message", () =>
        Effect.gen(function* () {
          const scratch = yield* makeScratchThread();
          const fake = makeFakeApi();
          const runner = yield* makeRunner({
            api: fake.api,
            sdk: makeFakeSdk().sdk,
            withoutProject: scratch.withoutProject,
          });

          yield* allocate(runner, {
            ...allocateInput(scratch.cwd, "Rebase pnpm#14673"),
            messageText: ` ${REBASE_MESSAGE}\n`,
          });

          assert.deepEqual(scratch.requests, [
            {
              cwd: scratch.cwd,
              messageText: REBASE_MESSAGE,
              model: "claude-opus-5-5",
              effortLevel: "xhigh",
            },
          ]);
          assert.deepInclude(fake.created[0], {
            source: {
              repoUrl: "https://github.com/u9g/pnpm",
              revision: "projects-graph-overrides",
            },
            outcomeBranch: "claude/rebase-pnpm-14673",
          });
          const session = yield* runner.open(openInput({ resume: false }));
          assert.deepEqual(session.startupNotices, [
            `Running in a Claude Code cloud session: ${WEB_URL}`,
            "This thread has no project, so Claude on this machine chose `u9g/pnpm` at `projects-graph-overrides`: The pull request's head branch is on the u9g fork.",
          ]);
          yield* session.close;
        }),
      );

      it.effect("starts a later session for the thread from the same choice", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const scratch = yield* makeScratchThread(
            Effect.succeed({ repository: "pnpm/pnpm", branch: null, reason: "" }),
          );
          const filesDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-cloud-files-",
          });
          const fake = makeFakeApi();
          const runner = yield* makeRunner({
            api: fake.api,
            sdk: makeFakeSdk().sdk,
            filesDir,
            withoutProject: scratch.withoutProject,
          });
          yield* allocate(runner, { ...allocateInput(scratch.cwd), messageText: REBASE_MESSAGE });

          // As when a session archived on claude.ai is replaced, after a restart.
          const restarted = yield* makeRunner({
            api: fake.api,
            sdk: makeFakeSdk().sdk,
            filesDir,
            withoutProject: scratch.withoutProject,
          });
          yield* allocate(restarted, {
            ...allocateInput(scratch.cwd),
            messageText: "now fix the failing test",
          });

          assert.lengthOf(scratch.requests, 1);
          assert.deepEqual(
            fake.created.map((created) => created.source),
            [
              { repoUrl: "https://github.com/pnpm/pnpm", revision: null },
              { repoUrl: "https://github.com/pnpm/pnpm", revision: null },
            ],
          );
          const session = yield* restarted.open(openInput({ resume: false }));
          assert.include(
            session.startupNotices ?? [],
            "This thread has no project, so its cloud session starts from `pnpm/pnpm`, which Claude chose when the thread began.",
          );
          yield* session.close;
        }),
      );

      it.effect("asks for the repository when Claude cannot tell or cannot run", () =>
        Effect.gen(function* () {
          const reasonFor = (
            answer: Effect.Effect<ClaudeCloudRepositoryChoice, ClaudeCloudRepositoryChoiceError>,
            // null: the thread is started without a message.
            messageText: string | null = REBASE_MESSAGE,
          ) =>
            Effect.gen(function* () {
              const scratch = yield* makeScratchThread(answer);
              const fake = makeFakeApi();
              const runner = yield* makeRunner({
                api: fake.api,
                sdk: makeFakeSdk().sdk,
                withoutProject: scratch.withoutProject,
              });
              const error = yield* allocate(runner, {
                ...allocateInput(scratch.cwd),
                ...(messageText === null ? {} : { messageText }),
              }).pipe(Effect.flip);
              assert.lengthOf(fake.created, 0);
              return { reason: error.reason, asked: scratch.requests.length };
            });

          assert.deepEqual(
            yield* reasonFor(
              Effect.fail(
                new ClaudeCloudRepositoryChoiceError({ reason: "not_chosen", detail: "Unclear." }),
              ),
            ),
            { reason: "repository_not_chosen", asked: 1 },
          );
          assert.deepEqual(
            yield* reasonFor(
              Effect.fail(
                new ClaudeCloudRepositoryChoiceError({ reason: "failed", detail: "Not logged in" }),
              ),
            ),
            { reason: "repository_choice_failed", asked: 1 },
          );
          assert.deepEqual(yield* reasonFor(Effect.die("unused"), null), {
            reason: "repository_not_chosen",
            asked: 0,
          });
        }),
      );

      it.effect("leaves a project's folder that is not a repository to the usual error", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const scratch = yield* makeScratchThread();
          const projectFolder = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-cloud-plain-",
          });
          const fake = makeFakeApi();
          const runner = yield* makeRunner({
            api: fake.api,
            sdk: makeFakeSdk().sdk,
            withoutProject: scratch.withoutProject,
          });

          const error = yield* allocate(runner, {
            ...allocateInput(projectFolder),
            messageText: REBASE_MESSAGE,
          }).pipe(Effect.flip);

          assert.equal(error.reason, "not_a_repository");
          assert.lengthOf(scratch.requests, 0);
          assert.lengthOf(fake.created, 0);
        }),
      );
    });
  });

  describe("open", () => {
    it.effect("shows startup notices only on the first open after creating the session", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const fake = makeFakeApi({ latestSequenceNum: 14 });
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        yield* allocate(runner, allocateInput(cwd, "Fix the flaky test"));

        const first = yield* runner.open(openInput({ resume: false }));
        assert.deepEqual(first.startupNotices, [
          `Running in a Claude Code cloud session: ${WEB_URL}`,
          "Uncommitted changes stay on this machine; the cloud session works from GitHub.",
        ]);
        // The session already runs with what it was created with, and its
        // container is still booting.
        assert.deepEqual(controlNames(sdk.queries[0]), []);
        yield* first.close;

        const second = yield* runner.open(openInput());
        assert.isUndefined(second.startupNotices);
        assert.sameMembers(controlNames(sdk.queries[1]), [
          "initialize",
          "setPermissionMode",
          "setModel",
          "applyFlagSettings",
        ]);
        assert.deepEqual(fake.latestSequenceNumReads, [SESSION_ID, SESSION_ID]);
        // Only the session it did not just create is checked for being archived.
        assert.deepEqual(fake.sessionReads, [SESSION_ID]);
      }),
    );

    it.effect(
      "attaches after the newest stored event with fresh headers and T3's MCP server relayed",
      () =>
        Effect.gen(function* () {
          const fake = makeFakeApi({ latestSequenceNum: 140 });
          const sdk = makeFakeSdk();
          const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });

          yield* runner.open(openInput());

          const options = sdk.queries[0]?.options;
          assert.deepEqual(options?.sse, {
            streamUrl: `https://cloud.test/v1/code/sessions/${SESSION_ID}/events/stream`,
            sendUrl: `https://cloud.test/v1/code/sessions/${SESSION_ID}/events`,
            sessionId: SESSION_ID,
            headers: { authorization: "Bearer token-1" },
            fromSequenceNum: 140,
          });
          // The cloud cannot reach T3's HTTP server, so an in-process one relays to it.
          assert.deepEqual(Object.keys(options?.mcpServers ?? {}), ["t3-code"]);
          assert.include(options?.mcpServers?.["t3-code"], { type: "sdk", name: "t3-code" });
          assert.deepEqual(sdk.queries[0]?.controls, [
            { method: "initialize" },
            { method: "setPermissionMode", argument: "default" },
            { method: "setModel", argument: "claude-opus-5-5" },
            {
              method: "applyFlagSettings",
              argument: { effortLevel: "xhigh", fastMode: false, ultracode: null },
            },
          ]);
        }),
    );

    it.effect("keeps the worker out of bypassPermissions and skips unchanged modes", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const query = sdk.queries[0]!;
        const modes = () =>
          query.controls.flatMap((control) =>
            control.method === "setPermissionMode" ? [control.argument] : [],
          );

        // The adapter re-applies its opened mode before every prompt.
        yield* session.setPermissionMode("bypassPermissions");
        assert.deepEqual(modes(), ["default"]);

        query.push(frame({ type: "system", subtype: "status", permissionMode: "plan" }));
        yield* session.messages.pipe(Stream.take(1), Stream.runDrain);
        yield* session.setPermissionMode("bypassPermissions");
        yield* session.setPermissionMode("acceptEdits");
        assert.deepEqual(modes(), ["default", "default", "acceptEdits"]);
      }),
    );

    it.effect("never sends an effort level the cloud does not know", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        yield* session.applyFlagSettings({
          effortLevel: "bogus" as EffortLevel,
          fastMode: true,
        });
        yield* session.applyFlagSettings({ effortLevel: "max", fastMode: null });

        assert.deepEqual(
          sdk.queries[0]?.controls
            .filter((control) => control.method === "applyFlagSettings")
            .slice(1)
            .map((control) => control.argument),
          [{ fastMode: true }, { effortLevel: "max", fastMode: null }],
        );
      }),
    );

    it.effect("fails an open whose session never starts and disconnects it", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk((method) =>
          method === "initialize" ? new Promise(() => {}) : answerControl(method),
        );
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });

        const open = yield* runner.open(openInput()).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("60 seconds");
        const error = yield* Fiber.join(open);

        assert.equal(error.method, "initialize");
        assert.equal(error.reason, "session_start_timed_out");
        assert.isTrue(sdk.queries[0]?.closed);
      }),
    );

    it.effect("fails at once for a session archived or deleted elsewhere", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const archived = makeFakeApi({
          session: (id) => Effect.succeed(cloudSession({ id, status: "archived" })),
        });
        const archivedError = yield* (yield* makeRunner({ api: archived.api, sdk: sdk.sdk }))
          .open(openInput())
          .pipe(Effect.flip);
        const deleted = makeFakeApi({
          session: () => Effect.fail(new ClaudeCloudNotFoundError({ operation: "getSession" })),
        });
        const deletedError = yield* (yield* makeRunner({ api: deleted.api, sdk: sdk.sdk }))
          .open(openInput())
          .pipe(Effect.flip);

        assert.equal(archivedError.reason, "session_archived");
        assert.equal(
          archivedError.message,
          "This Claude Code cloud session was archived, so it can't take new messages. Start a new thread to keep going.",
        );
        assert.equal(deletedError.reason, "session_missing");
        assert.deepEqual(archived.latestSequenceNumReads, []);
        assert.lengthOf(sdk.queries, 0);
      }),
    );

    it.effect("tells the user when the Claude login cannot be used", () =>
      Effect.gen(function* () {
        const fake = makeFakeApi({
          beforeTransport: () =>
            Effect.fail(new ClaudeCloudCredentialsError({ reason: "expired", store: "file" })),
        });
        const runner = yield* makeRunner({ api: fake.api, sdk: makeFakeSdk().sdk });

        const error = yield* runner.open(openInput()).pipe(Effect.flip);

        assert.equal(error.reason, "login_expired");
        assert.equal(
          error.message,
          "The Claude login has expired. Run `claude` once to refresh it, or sign in again with `claude auth login`.",
        );
      }),
    );
  });

  describe("starting", () => {
    /** Creates a session for a repository and opens it for its first turn. */
    const openCreated = (session: () => ClaudeCloudSession) =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const fake = makeFakeApi({ session: () => Effect.sync(session) });
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        yield* allocate(runner, allocateInput(cwd));
        const opened = yield* runner.open(openInput({ resume: false }));
        const consumer = yield* consume(opened);
        return { fake, sdk, opened, consumer, query: sdk.queries[0]! };
      });

    it.effect("fails a new session's stream once its worker cannot check out the branch", () =>
      Effect.gen(function* () {
        let session = cloudSession({ ...BOOTING });
        const { fake, opened, consumer, query } = yield* openCreated(() => session);
        yield* opened.offer(FIRST_PROMPT);
        yield* query.untilPosted(1);
        // The container's boot log, and frames from clients, are not the worker.
        const typedOnClaudeAi = frame({
          type: "user",
          message: { role: "user", content: "From the web" },
          parent_tool_use_id: null,
          uuid: "22222222-2222-4222-8222-222222222222",
          session_id: "",
        });
        query.echo(FIRST_PROMPT, 15);
        query.push(frame({ type: "env_manager_log", uuid: "env-clone", data: {} }), {
          event_id: "e16",
          sequence_num: 16,
          source: "worker",
        });
        query.push(typedOnClaudeAi, { event_id: "e17", sequence_num: 17, source: "client" });
        // Nor is what the cloud sends, as the worker, when the checkout fails.
        const checkoutFailed = frame({
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "The requested branch or commit was not found." }],
          },
          uuid: "33333333-3333-4333-8333-333333333333",
        });
        const noTurn = frame({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 0,
          errors: ["The requested branch or commit was not found."],
          uuid: "44444444-4444-4444-8444-444444444444",
        });
        query.push(checkoutFailed, { event_id: "e18", sequence_num: 18, source: "worker" });
        query.push(noTurn, { event_id: "e19", sequence_num: 19, source: "worker" });
        yield* consumer.untilReceived(noTurn);
        yield* TestClock.adjust("5 seconds");
        assert.deepEqual(fake.sessionReads, [SESSION_ID]);

        session = cloudSession({ ...BOOTING, lastInitError: BRANCH_NOT_FOUND });
        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip);

        assert.equal(error.reason, "branch_not_found");
        assert.equal(
          error.message,
          "The Claude Code cloud session couldn't check out the branch from GitHub, so it never started. Check that the branch is pushed and still exists on GitHub, then start a new thread.",
        );
        assert.isTrue(query.closed);
        const offered = yield* opened.offer(SECOND_PROMPT).pipe(Effect.flip);
        assert.equal(offered.reason, "branch_not_found");
      }),
    );

    it.effect.each([
      {
        case: "a start that failed some other way",
        session: { lastInitError: { ...BRANCH_NOT_FOUND, type: "setup_script_failed" } },
        reason: "session_start_failed",
      },
      {
        case: "a container the cloud could not provision",
        session: { status: "failed" },
        reason: "session_start_failed",
      },
      {
        case: "an environment deleted under it",
        session: {
          lastInitError: { kind: "environment_deleted", type: null, recoverable: true, at: null },
        },
        reason: "environment_deleted",
      },
      {
        case: "a session archived while it started",
        session: { status: "archived" },
        reason: "session_archived",
      },
    ] satisfies ReadonlyArray<{
      readonly case: string;
      readonly session: Partial<ClaudeCloudSession>;
      readonly reason: ClaudeAdapterV2.ClaudeCloudFailureReason;
    }>)("fails a new session's stream for $case", ({ session, reason }) =>
      Effect.gen(function* () {
        const { consumer } = yield* openCreated(() => cloudSession({ ...BOOTING, ...session }));
        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip);
        assert.equal(error.reason, reason);
      }),
    );

    it.effect("gives a recoverable init error two minutes before failing the start", () =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const { fake, consumer } = yield* openCreated(() =>
          cloudSession({
            ...BOOTING,
            lastInitError: { ...BRANCH_NOT_FOUND, recoverable: true, at },
          }),
        );
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(fake.sessionReads, 24);
        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip);
        assert.equal(error.reason, "branch_not_found");
      }),
    );

    it.effect("stops reading the session once the worker sends a frame", () =>
      Effect.gen(function* () {
        const { fake, consumer, query } = yield* openCreated(() =>
          cloudSession({ ...BOOTING, lastInitError: BRANCH_NOT_FOUND }),
        );
        const init = frame({ type: "system", subtype: "init", uuid: "init", session_id: "" });
        const assistant = frame({ type: "assistant", uuid: "assistant-1", session_id: "" });
        query.push(init, { event_id: "e15", sequence_num: 15, source: "worker" });
        yield* consumer.untilReceived(init);
        yield* TestClock.adjust("5 minutes");
        query.push(assistant, { event_id: "e16", sequence_num: 16, source: "worker" });
        yield* consumer.untilReceived(assistant);

        assert.deepEqual(fake.sessionReads, []);
      }),
    );

    it.effect("gives up on a worker that never attaches within three minutes", () =>
      Effect.gen(function* () {
        const { fake, consumer } = yield* openCreated(() => cloudSession({ ...BOOTING }));
        yield* TestClock.adjust("3 minutes");
        const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip);

        assert.equal(error.reason, "session_start_timed_out");
        assert.lengthOf(fake.sessionReads, 36);
      }),
    );

    it.effect("leaves an attached but quiet worker to the stream after three minutes", () =>
      Effect.gen(function* () {
        const { fake, consumer, query } = yield* openCreated(() => cloudSession());
        yield* TestClock.adjust("10 minutes");
        const late = frame({ type: "assistant", uuid: "late", session_id: "" });
        query.push(late, { event_id: "e15", sequence_num: 15, source: "worker" });
        yield* consumer.untilReceived(late);

        assert.lengthOf(fake.sessionReads, 36);
      }),
    );

    it.effect("wakes a stopped session with the prompt, sending its controls first", () =>
      Effect.gen(function* () {
        // Nothing is answered until the prompt boots the container.
        let boot = () => {};
        const booted = new Promise<void>((resolve) => {
          boot = resolve;
        });
        const sdk = makeFakeSdk((method) => booted.then(() => answerControl(method)));
        const runner = yield* makeRunner({
          api: makeFakeApi({ session: () => Effect.succeed(cloudSession({ ...STOPPED })) }).api,
          sdk: sdk.sdk,
        });

        const opened = yield* runner.open(openInput());
        const query = sdk.queries[0]!;
        const consumer = yield* consume(opened);
        assert.deepEqual(controlNames(query), [
          "setPermissionMode",
          "setModel",
          "applyFlagSettings",
        ]);
        yield* opened.offer(FIRST_PROMPT);
        yield* query.untilPosted(1);

        boot();
        query.echo(FIRST_PROMPT, 15);
        const init = frame({ type: "system", subtype: "init", uuid: "init" });
        query.push(init, { event_id: "e16", sequence_num: 16, source: "worker" });
        yield* consumer.untilReceived(init);
        // The answered mode is not sent again before the next prompt.
        yield* opened.setPermissionMode("bypassPermissions");
        assert.lengthOf(
          query.controls.filter((control) => control.method === "setPermissionMode"),
          1,
        );
        assert.isFalse(query.closed);
      }),
    );

    it.effect("fails a reattached session's stream once its worker fails to boot", () =>
      Effect.gen(function* () {
        let session = cloudSession({ ...BOOTING });
        const sdk = makeFakeSdk((method) =>
          method === "initialize" ? new Promise(() => {}) : answerControl(method),
        );
        const runner = yield* makeRunner({
          api: makeFakeApi({ session: () => Effect.sync(() => session) }).api,
          sdk: sdk.sdk,
        });

        const opened = yield* runner.open(openInput());
        const consumer = yield* consume(opened);
        yield* opened.offer(FIRST_PROMPT);
        session = cloudSession({ ...BOOTING, lastInitError: BRANCH_NOT_FOUND });
        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip);

        assert.equal(error.reason, "branch_not_found");
        assert.isTrue(sdk.queries[0]?.closed);
      }),
    );
  });

  describe("checkResumable", () => {
    it.effect("refuses only sessions that can never take another turn", () =>
      Effect.gen(function* () {
        const check = (session: () => Effect.Effect<ClaudeCloudSession, ClaudeCloudApiError>) =>
          Effect.gen(function* () {
            const runner = yield* makeRunner({
              api: makeFakeApi({ session }).api,
              sdk: makeFakeSdk().sdk,
            });
            assert.isDefined(runner.checkResumable);
            if (runner.checkResumable === undefined) return undefined;
            return yield* runner.checkResumable(SESSION_ID).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
              Effect.orElseSucceed(() => "resumable"),
            );
          });
        const withSession = (overrides: Partial<ClaudeCloudSession>) => () =>
          Effect.succeed(cloudSession(overrides));
        const withStatus = (status: string) => withSession({ status });

        assert.equal(yield* check(withStatus("archived")), "session_archived");
        assert.equal(yield* check(withStatus("failed")), "session_failed");
        assert.equal(
          yield* check(() =>
            Effect.fail(new ClaudeCloudNotFoundError({ operation: "getSession" })),
          ),
          "session_missing",
        );
        assert.equal(yield* check(withStatus("paused")), "resumable");
        // Their status stays active, so the init error is what tells.
        assert.equal(
          yield* check(withSession({ ...BOOTING, lastInitError: BRANCH_NOT_FOUND })),
          "branch_not_found",
        );
        assert.equal(
          yield* check(
            withSession({
              ...BOOTING,
              lastInitError: { ...BRANCH_NOT_FOUND, type: "setup_script_failed" },
            }),
          ),
          "session_start_failed",
        );
        assert.equal(
          yield* check(
            withSession({
              lastInitError: {
                kind: "environment_deleted",
                type: null,
                recoverable: true,
                at: null,
              },
            }),
          ),
          "environment_deleted",
        );
        // A worker that is up has recovered, a recoverable error may still be
        // retried, and a bridge session runs on its own machine.
        assert.equal(
          yield* check(withSession({ workerStatus: "running", lastInitError: BRANCH_NOT_FOUND })),
          "resumable",
        );
        assert.equal(
          yield* check(
            withSession({
              ...BOOTING,
              lastInitError: {
                ...BRANCH_NOT_FOUND,
                recoverable: true,
                at: yield* Clock.currentTimeMillis,
              },
            }),
          ),
          "resumable",
        );
        assert.equal(
          yield* check(
            withSession({ ...BOOTING, environmentKind: "bridge", lastInitError: BRANCH_NOT_FOUND }),
          ),
          "resumable",
        );
        // A failed status read must not abandon the session for a new one.
        assert.equal(
          yield* check(() =>
            Effect.fail(new ClaudeCloudHttpError({ operation: "getSession", status: 503 })),
          ),
          "resumable",
        );
      }),
    );
  });

  describe("messages", () => {
    it.effect("drops its own prompt echoes, env_manager_log and replayed command output", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const query = sdk.queries[0]!;
        const steer = {
          type: "user",
          message: { role: "user", content: "Also this" },
          parent_tool_use_id: null,
          priority: "now",
        } satisfies SDKUserMessage;

        yield* session.offer(FIRST_PROMPT);
        yield* session.offer(steer);
        yield* query.untilPosted(2);
        assert.deepEqual(query.posted[0], FIRST_PROMPT);
        const sentSteer = query.posted[1];
        const steerUuid = sentSteer?.uuid;
        assert.isDefined(steerUuid);
        if (steerUuid === undefined) return;
        assert.deepEqual(sentSteer, { ...steer, uuid: steerUuid });

        const steerEcho = frame({ ...steer, uuid: steerUuid, session_id: "" });
        const envLog = frame({ type: "env_manager_log", uuid: "env-log", data: {} });
        const typedOnClaudeAi = frame({
          type: "user",
          message: { role: "user", content: "From the web" },
          parent_tool_use_id: null,
          uuid: "22222222-2222-4222-8222-222222222222",
          session_id: "",
        });
        const workerReplay = frame({
          type: "user",
          message: { role: "user", content: "Hello" },
          parent_tool_use_id: null,
          uuid: FIRST_UUID,
          isReplay: true,
          session_id: "",
        });
        const modelChanged = frame({
          type: "user",
          message: {
            role: "user",
            content:
              "<local-command-stdout>Set model to `claude-sonnet-5-5`</local-command-stdout>",
          },
          parent_tool_use_id: null,
          uuid: "44444444-4444-4444-8444-444444444444",
          isReplay: true,
          session_id: "",
        });
        const assistant = frame({ type: "assistant", uuid: "assistant-1", session_id: "" });
        query.echo(FIRST_PROMPT, 15);
        query.push(steerEcho, { event_id: "e2", sequence_num: 16, source: "client" });
        query.push(envLog, { event_id: "e3", sequence_num: 17, source: "worker" });
        query.push(typedOnClaudeAi, { event_id: "e4", sequence_num: 18, source: "client" });
        query.push(workerReplay, { event_id: "e5", sequence_num: 19, source: "worker" });
        query.push(modelChanged, { event_id: "e6", sequence_num: 20, source: "worker" });
        query.push(assistant, { event_id: "e7", sequence_num: 21, source: "worker" });

        const delivered = yield* session.messages.pipe(Stream.take(3), Stream.runCollect);
        assert.deepEqual(Array.from(delivered), [typedOnClaudeAi, workerReplay, assistant]);
      }),
    );

    it.effect("sends a prompt its rejected query took again on the replacement", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const first = sdk.queries[0]!;
        const before = frame({ type: "assistant", uuid: "before", session_id: "" });
        const after = frame({ type: "assistant", uuid: "after", session_id: "" });

        const consumer = yield* consume(session);
        first.push(before, { event_id: "e1", sequence_num: 20 });
        yield* consumer.untilReceived(before);
        // The token expired while the stream stayed open, so the prompt's POST
        // is the request that gets the 401.
        yield* session.offer(FIRST_PROMPT);
        yield* first.untilPosted(1);
        first.fail(sseError(401));
        yield* sdk.untilQueries(2);
        const second = sdk.queries[1]!;
        yield* second.untilPosted(1);
        second.push(after, { event_id: "e2", sequence_num: 25 });
        yield* consumer.untilReceived(after);

        assert.deepEqual(consumer.received, [before, after]);
        assert.isTrue(first.closed);
        assert.equal(second.options.sse?.fromSequenceNum, 20);
        assert.deepEqual(second.options.sse?.headers, { authorization: "Bearer token-2" });
        assert.deepEqual(second.posted, [FIRST_PROMPT]);
      }),
    );

    it.effect("does not send a prompt the session already stored again", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const first = sdk.queries[0]!;
        const marker = frame({ type: "assistant", uuid: "marker", session_id: "" });

        const consumer = yield* consume(session);
        yield* session.offer(FIRST_PROMPT);
        yield* session.offer(SECOND_PROMPT);
        yield* first.untilPosted(2);
        first.echo(FIRST_PROMPT, 15);
        first.push(marker, { event_id: "e16", sequence_num: 16 });
        yield* consumer.untilReceived(marker);
        first.fail(new TypeError("fetch failed"));
        yield* sdk.untilQueries(2);
        const second = sdk.queries[1]!;
        yield* second.untilPosted(1);

        assert.deepEqual(second.posted, [SECOND_PROMPT]);
      }),
    );

    it.effect("holds prompts and controls issued while the replacement connects", () =>
      Effect.gen(function* () {
        const loginRead = yield* Deferred.make<void>();
        const loginRefreshed = yield* Deferred.make<void>();
        const sdk = makeFakeSdk();
        const fake = makeFakeApi({
          // The second login read is the CLI refreshing an expired token.
          beforeTransport: (count) =>
            count === 2
              ? Deferred.succeed(loginRead, undefined).pipe(
                  Effect.andThen(Deferred.await(loginRefreshed)),
                )
              : Effect.void,
        });
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const first = sdk.queries[0]!;

        yield* consume(session);
        first.fail(sseError(401));
        yield* Deferred.await(loginRead);
        yield* session.offer(FIRST_PROMPT);
        const setModel = yield* session.setModel("claude-sonnet-5-5").pipe(Effect.forkChild);
        yield* Deferred.succeed(loginRefreshed, undefined);
        yield* Fiber.join(setModel);
        yield* sdk.untilQueries(2);
        const second = sdk.queries[1]!;
        yield* second.untilPosted(1);

        const modelChanges = (query: FakeQuery) =>
          query.controls.filter((control) => control.argument === "claude-sonnet-5-5");
        assert.deepEqual(first.posted, []);
        assert.deepEqual(second.posted, [FIRST_PROMPT]);
        assert.lengthOf(modelChanges(first), 0);
        assert.lengthOf(modelChanges(second), 1);
      }),
    );

    it.effect("sends a prompt the session never stored again, then gives up on it", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        const consumer = yield* consume(session);
        // The SDK dropped the POST after its retries and never said so.
        yield* session.offer(FIRST_PROMPT);
        yield* sdk.queries[0]!.untilPosted(1);
        yield* TestClock.adjust("30 seconds");
        yield* sdk.untilQueries(2);
        yield* sdk.queries[1]!.untilPosted(1);
        assert.deepEqual(sdk.queries[1]!.posted, [FIRST_PROMPT]);
        assert.isTrue(sdk.queries[0]!.closed);

        yield* TestClock.adjust("30 seconds");
        yield* sdk.untilQueries(3);
        yield* sdk.queries[2]!.untilPosted(1);
        yield* TestClock.adjust("30 seconds");
        yield* sdk.untilQueries(4);
        yield* sdk.queries[3]!.untilPosted(1);
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.await(consumer.fiber);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.include(String(exit.cause), "did not receive the message");
        }
        const error = yield* session.offer(SECOND_PROMPT).pipe(Effect.flip);
        assert.equal(error.reason, "message_not_received");
        assert.equal(
          error.message,
          "The Claude Code cloud session did not receive the message. Send it again.",
        );
      }),
    );

    it.effect("stops watching a prompt once the session echoes it", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const query = sdk.queries[0]!;
        const marker = frame({ type: "assistant", uuid: "marker", session_id: "" });

        const consumer = yield* consume(session);
        yield* session.offer(FIRST_PROMPT);
        yield* query.untilPosted(1);
        query.echo(FIRST_PROMPT, 15);
        query.push(marker, { event_id: "e16", sequence_num: 16 });
        yield* consumer.untilReceived(marker);
        yield* TestClock.adjust("5 minutes");

        assert.lengthOf(sdk.queries, 1);
        assert.isFalse(query.closed);
      }),
    );

    it.effect("replaces its query before the login in its headers expires", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const now = yield* Clock.currentTimeMillis;
        const fake = makeFakeApi({ latestSequenceNum: 30, expiresAt: now + 60 * MINUTE });
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        yield* consume(session);
        yield* TestClock.adjust("55 minutes");
        assert.lengthOf(sdk.queries, 1);
        yield* TestClock.adjust("1 minute");
        yield* sdk.untilQueries(2);

        assert.isTrue(sdk.queries[0]?.closed);
        assert.deepEqual(sdk.queries[1]?.options.sse?.headers, {
          authorization: "Bearer token-2",
        });
        assert.equal(sdk.queries[1]?.options.sse?.fromSequenceNum, 30);
      }),
    );

    it.effect("fails when the session is gone instead of reconnecting", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const gone = sseError(404);

        sdk.queries[0]!.fail(gone);
        const error = yield* session.messages.pipe(Stream.runDrain, Effect.flip);

        assert.equal(error.method, "messages");
        assert.strictEqual(error.cause, gone);
        assert.equal(error.reason, "session_missing");
        assert.lengthOf(sdk.queries, 1);
      }),
    );

    it.effect("fails instead of reconnecting to a session archived meanwhile", () =>
      Effect.gen(function* () {
        let status = "active";
        const sdk = makeFakeSdk();
        const fake = makeFakeApi({
          session: (id) => Effect.sync(() => cloudSession({ id, status })),
        });
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        status = "archived";
        sdk.queries[0]!.fail(new TypeError("fetch failed"));
        const error = yield* session.messages.pipe(Stream.runDrain, Effect.flip);

        assert.equal(error.reason, "session_archived");
        assert.lengthOf(sdk.queries, 1);
      }),
    );

    it.effect("gives up after repeated reconnects that deliver nothing", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const failing = (fake: FakeQuery) => fake.fail(new TypeError("fetch failed"));
        const runner = yield* makeRunner({
          api: makeFakeApi().api,
          sdk: {
            ...sdk.sdk,
            query: (options) => {
              const query = sdk.sdk.query(options);
              failing(sdk.queries.at(-1)!);
              return query;
            },
          },
        });
        const session = yield* runner.open(openInput());

        const drained = yield* session.messages.pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(drained);

        assert.equal(error.reason, "connection_lost");
        assert.lengthOf(sdk.queries, 6);
      }),
    );

    it.effect("ends without reconnecting once closed, and takes no more prompts", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        const drained = yield* session.messages.pipe(Stream.runDrain, Effect.forkChild);
        yield* session.close;
        yield* Fiber.join(drained);
        const error = yield* session.offer(FIRST_PROMPT).pipe(Effect.flip);

        assert.isTrue(sdk.queries[0]?.closed);
        assert.lengthOf(sdk.queries, 1);
        assert.equal(error.method, "close");
        assert.deepEqual(sdk.queries[0]?.posted, []);
      }),
    );
  });

  describe("controls", () => {
    it.effect("answers a permission request again with the first answer", () =>
      Effect.gen(function* () {
        const asked: Array<string> = [];
        const allow: PermissionResult = { behavior: "allow", updatedInput: {} };
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        yield* runner.open(
          openInput({
            canUseTool: async (_toolName, _input, options) => {
              asked.push(options.requestId);
              return options.signal.aborted ? null : allow;
            },
          }),
        );
        const canUseTool = sdk.queries[0]?.options.canUseTool;
        assert.isDefined(canUseTool);
        if (canUseTool === undefined) return;
        const ask = (requestId: string, signal = new AbortController().signal) =>
          Effect.promise(() => canUseTool("Bash", {}, { signal, toolUseID: "toolu", requestId }));

        assert.deepEqual(yield* ask("request-1"), allow);
        // Redelivered because the answer's POST was lost: the same answer goes again.
        assert.deepEqual(yield* ask("request-1"), allow);
        // Never answered: the query closed under it, so the redelivery asks again.
        assert.isNull(yield* ask("request-2", AbortSignal.abort()));
        assert.deepEqual(yield* ask("request-2"), allow);
        assert.deepEqual(asked, ["request-1", "request-2", "request-2"]);
      }),
    );

    it.effect("stops the turn and its queued prompts once the session has them", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk((method) =>
          method === "interrupt"
            ? Promise.resolve({ still_queued: [], cancelled: [SECOND_UUID] })
            : answerControl(method),
        );
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const query = sdk.queries[0]!;
        const marker = frame({ type: "assistant", uuid: "marker", session_id: "" });

        const consumer = yield* consume(session);
        yield* session.offer(FIRST_PROMPT);
        yield* session.offer(SECOND_PROMPT);
        const interrupt = yield* session.interrupt.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* query.untilPosted(2);
        query.echo(FIRST_PROMPT, 15);
        query.push(marker, { event_id: "e16", sequence_num: 16 });
        yield* consumer.untilReceived(marker);
        // Sent now, the interrupt would reach the session before the second
        // prompt, which would then run after the Stop.
        assert.notInclude(controlNames(query), "interrupt");
        query.echo(SECOND_PROMPT, 17);
        const receipt = yield* Fiber.join(interrupt);

        assert.deepEqual(query.controls.at(-1), {
          method: "interrupt",
          argument: { cancelQueued: true },
        });
        assert.deepEqual(receipt, { stillQueued: [], cancelled: [SECOND_UUID] });
      }),
    );

    it.effect("never sends a prompt the session did not store before a Stop again", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk();
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const first = sdk.queries[0]!;
        const marker = frame({ type: "assistant", uuid: "marker", session_id: "" });

        const consumer = yield* consume(session);
        yield* session.offer(FIRST_PROMPT);
        yield* first.untilPosted(1);
        const interrupt = yield* session.interrupt.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(interrupt);
        first.fail(new TypeError("fetch failed"));
        yield* sdk.untilQueries(2);
        sdk.queries[1]!.push(marker, { event_id: "e30", sequence_num: 30 });
        yield* consumer.untilReceived(marker);

        assert.include(controlNames(first), "interrupt");
        assert.deepEqual(sdk.queries[1]!.posted, []);
      }),
    );

    it.effect("does not send an unstored prompt on the replacement a Stop waits for", () =>
      Effect.gen(function* () {
        const loginRead = yield* Deferred.make<void>();
        const loginRefreshed = yield* Deferred.make<void>();
        const sdk = makeFakeSdk();
        const fake = makeFakeApi({
          beforeTransport: (count) =>
            count === 2
              ? Deferred.succeed(loginRead, undefined).pipe(
                  Effect.andThen(Deferred.await(loginRefreshed)),
                )
              : Effect.void,
        });
        const runner = yield* makeRunner({ api: fake.api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());
        const first = sdk.queries[0]!;

        yield* consume(session);
        // The prompt's POST is the request that finds the token expired.
        yield* session.offer(FIRST_PROMPT);
        yield* first.untilPosted(1);
        first.fail(sseError(401));
        yield* Deferred.await(loginRead);
        const interrupt = yield* session.interrupt.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        // The login refresh outlasts the interrupt's wait for the prompt.
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.succeed(loginRefreshed, undefined);
        yield* Fiber.join(interrupt);
        const second = sdk.queries[1]!;
        yield* session.offer(SECOND_PROMPT);
        yield* second.untilPosted(1);

        assert.include(controlNames(second), "interrupt");
        assert.deepEqual(second.posted, [SECOND_PROMPT]);
      }),
    );

    it.effect("times out a control request the cloud never answers", () =>
      Effect.gen(function* () {
        const sdk = makeFakeSdk((method) =>
          method === "stopTask" ? new Promise(() => {}) : answerControl(method),
        );
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        const stop = yield* session.stopTask("task-1").pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        const error = yield* Fiber.join(stop);

        assert.equal(error.method, "stopTask");
        assert.equal(error.reason, "control_timed_out");
      }),
    );

    it.effect("counts a task the session already ended as stopped", () =>
      Effect.gen(function* () {
        // What the CLI answers for a task it forgot, one that finished, and a
        // refusal that leaves the task running.
        const refusals = [
          new Error("No task found with ID: task-forgotten"),
          new Error("Task task-done is not running (status: completed)"),
          new Error("Task task-running is owned by agent-1; agent-2 cannot stop it."),
        ];
        const sdk = makeFakeSdk((method) =>
          method === "stopTask"
            ? Promise.reject(refusals.shift() ?? new Error("Unexpected stop."))
            : answerControl(method),
        );
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk });
        const session = yield* runner.open(openInput());

        yield* session.stopTask("task-forgotten");
        yield* session.stopTask("task-done");
        const refused = yield* session.stopTask("task-running").pipe(Effect.flip);

        assert.equal(refused.reason, "task_stop_failed");
        assert.equal(
          refused.message,
          "The Claude Code cloud session could not stop the task. Try again.",
        );
      }),
    );

    it.effect("cannot fork and finds no local subagent transcripts", () =>
      Effect.gen(function* () {
        const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: makeFakeSdk().sdk });

        const error = yield* runner
          .forkSession({
            sessionId: SESSION_ID,
            options: {},
            environment: {},
            threadId: THREAD_ID,
            providerSessionId: PROVIDER_SESSION_ID,
          })
          .pipe(Effect.flip);
        const toolUseId = yield* runner.subagentLaunchToolUseId({
          sessionId: SESSION_ID,
          agentId: "agent-1",
          dir: null,
          threadId: THREAD_ID,
          providerSessionId: PROVIDER_SESSION_ID,
        });

        assert.equal(error.reason, "fork_unsupported");
        assert.isNull(toolUseId);
      }),
    );
  });

  describe("fetchSentFile", () => {
    const FILE_UUID = "d56e0bb8-4d97-4899-9e40-56adcab71b5c";
    const BYTES = new TextEncoder().encode("video bytes");
    const SENT = {
      threadId: THREAD_ID,
      fileUuid: FILE_UUID,
      path: "/tmp/claude-0/scratchpad/how:it?works.mp4",
    };
    const makeFilesDir = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-files-" });
    });

    it.effect("saves a sent file once, in its thread's folder", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filesDir = yield* makeFilesDir;
        const downloads: Array<string> = [];
        const runner = yield* makeRunner({
          api: makeFakeApi({
            downloadFile: (fileUuid) =>
              Effect.sync(() => {
                downloads.push(fileUuid);
                return { sizeBytes: BYTES.byteLength, stream: Stream.make(BYTES) };
              }),
          }).api,
          sdk: makeFakeSdk().sdk,
          filesDir,
        });

        const saved = yield* runner.fetchSentFile!(SENT);

        assert.equal(saved, path.join(filesDir, THREAD_ID, FILE_UUID, "how_it_works.mp4"));
        assert.deepEqual(yield* fileSystem.readFile(saved), BYTES);
        assert.equal(yield* runner.fetchSentFile!(SENT), saved);
        assert.deepEqual(downloads, [FILE_UUID]);
      }),
    );

    it.effect("refuses a file over the download limit without saving anything", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filesDir = yield* makeFilesDir;
        const runner = yield* makeRunner({
          api: makeFakeApi({
            downloadFile: () =>
              Effect.succeed({ sizeBytes: 300 * 1024 * 1024, stream: Stream.make(BYTES) }),
          }).api,
          sdk: makeFakeSdk().sdk,
          filesDir,
        });

        const error = yield* runner.fetchSentFile!(SENT).pipe(Effect.flip);

        assert.equal(error.reason, "sent_file_too_large");
        assert.isFalse(yield* fileSystem.exists(path.join(filesDir, THREAD_ID)));
      }),
    );

    it.effect("refuses a thread id that can't name a folder of its own", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const filesDir = yield* makeFilesDir;
        const downloads: Array<string> = [];
        const runner = yield* makeRunner({
          api: makeFakeApi({
            downloadFile: (fileUuid) =>
              Effect.sync(() => {
                downloads.push(fileUuid);
                return { sizeBytes: BYTES.byteLength, stream: Stream.make(BYTES) };
              }),
          }).api,
          sdk: makeFakeSdk().sdk,
          filesDir,
        });

        const error = yield* runner.fetchSentFile!({ ...SENT, threadId: ThreadId.make("..") }).pipe(
          Effect.flip,
        );

        assert.equal(error.reason, "sent_file_unsaved");
        assert.deepEqual(downloads, []);
        assert.deepEqual(yield* fileSystem.readDirectory(filesDir), []);
      }),
    );

    it.effect("removes a download the stream cut short", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filesDir = yield* makeFilesDir;
        const runner = yield* makeRunner({
          api: makeFakeApi({
            downloadFile: () =>
              Effect.succeed({
                sizeBytes: undefined,
                stream: Stream.make(BYTES).pipe(
                  Stream.concat(
                    Stream.fail(new ClaudeCloudHttpError({ operation: "downloadFile" })),
                  ),
                ),
              }),
          }).api,
          sdk: makeFakeSdk().sdk,
          filesDir,
        });

        const error = yield* runner.fetchSentFile!(SENT).pipe(Effect.flip);

        assert.equal(error.reason, "request_failed");
        assert.deepEqual(yield* fileSystem.readDirectory(path.join(filesDir, THREAD_ID)), [
          FILE_UUID,
        ]);
        assert.deepEqual(
          yield* fileSystem.readDirectory(path.join(filesDir, THREAD_ID, FILE_UUID)),
          [],
        );
      }),
    );

    it.effect("writes a download beside its file's folder until it completes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filesDir = yield* makeFilesDir;
        const firstChunkWritten = yield* Deferred.make<void>();
        const rest = yield* Deferred.make<void>();
        const runner = yield* makeRunner({
          api: makeFakeApi({
            downloadFile: () =>
              Effect.succeed({
                sizeBytes: undefined,
                stream: Stream.make(BYTES).pipe(
                  Stream.concat(
                    Stream.fromEffectDrain(
                      Deferred.succeed(firstChunkWritten, undefined).pipe(
                        Effect.andThen(Deferred.await(rest)),
                      ),
                    ),
                  ),
                  Stream.concat(Stream.make(BYTES)),
                ),
              }),
          }).api,
          sdk: makeFakeSdk().sdk,
          filesDir,
        });
        const threadFolder = path.join(filesDir, THREAD_ID);

        const download = yield* runner.fetchSentFile!(SENT).pipe(Effect.forkChild);
        yield* Deferred.await(firstChunkWritten);

        // The sweep removes old partials only from here, where no saved file ever is.
        assert.deepEqual((yield* fileSystem.readDirectory(threadFolder)).toSorted(), [
          FILE_UUID,
          claudeCloudPartialFileName(FILE_UUID),
        ]);
        assert.deepEqual(yield* fileSystem.readDirectory(path.join(threadFolder, FILE_UUID)), []);

        yield* Deferred.succeed(rest, undefined);
        const saved = yield* Fiber.join(download);
        assert.deepEqual(yield* fileSystem.readDirectory(threadFolder), [FILE_UUID]);
        assert.equal(yield* fileSystem.readFileString(saved), "video bytesvideo bytes");
      }),
    );
  });

  it.effect("writes the native protocol log as Claude Cloud, without the login", () =>
    Effect.gen(function* () {
      const nativeLog: Array<unknown> = [];
      const sdk = makeFakeSdk();
      const runner = yield* makeRunner({ api: makeFakeApi().api, sdk: sdk.sdk, nativeLog });
      const session = yield* runner.open(openInput());
      const assistant = frame({ type: "assistant", uuid: "assistant-1", session_id: "" });

      yield* session.offer(FIRST_PROMPT);
      sdk.queries[0]!.push(assistant, { event_id: "e1", sequence_num: 15 });
      yield* session.messages.pipe(Stream.take(1), Stream.runDrain);
      yield* session.close;

      const payloads = nativeLog.map((entry) => {
        assert.deepInclude(entry, { provider: "claudeCloud", kind: "protocol" });
        return Reflect.get(Reflect.get(Object(entry), "event"), "payload");
      });
      assert.sameMembers(
        payloads.map((payload) => Reflect.get(Object(payload), "type")),
        [
          "query.open",
          "query.set_permission_mode",
          "query.set_model",
          "query.apply_flag_settings",
          "prompt.offer",
          "assistant",
          "query.close",
        ],
      );
      assert.notInclude(JSON.stringify(nativeLog), "Bearer");
    }),
  );
});
