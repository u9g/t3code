import type {
  CanUseTool,
  EffortLevel,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getCcrEvent,
  getSseLastSequenceNum,
  query as browserQuery,
  type Query,
} from "@anthropic-ai/claude-agent-sdk/browser";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";
import type {
  ClaudeCloudApi,
  ClaudeCloudApiError,
  ClaudeCloudSession,
} from "../../provider/claudeCloud/ClaudeCloudApi.ts";
import {
  CLAUDE_CLOUD_LOGIN_EXPIRY_MARGIN_MS,
  type ClaudeCloudCredentialsError,
} from "../../provider/claudeCloud/ClaudeCloudCredentials.ts";
import {
  type ClaudeCloudNoEnvironmentError,
  resolveClaudeCloudEnvironment,
} from "../../provider/claudeCloud/ClaudeCloudEnvironment.ts";
import {
  CLAUDE_CLOUD_REPOSITORY_CHOICE_FILE_NAME,
  claudeCloudPartialFileName,
  claudeCloudThreadFolder,
} from "../../provider/claudeCloud/ClaudeCloudFiles.ts";
import { resolveClaudeCloudRepository } from "../../provider/claudeCloud/ClaudeCloudRepository.ts";
import {
  type ChooseClaudeCloudRepository,
  ClaudeCloudRepositoryChoice,
} from "../../provider/claudeCloud/ClaudeCloudRepositoryChoice.ts";
import type * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkProtocolLogEvent,
  type ClaudeAgentSdkQueryOpenInput,
  type ClaudeAgentSdkQueryOptions,
  type ClaudeAgentSdkQuerySession,
  type ClaudeAgentSdkSentFileInput,
  type ClaudeAgentSdkSessionAllocateInput,
  type ClaudeCloudFailureReason,
  type ClaudeQueryInterruptReceipt,
  claudeQueryMessages,
  claudeRuntimeQueryPolicyForRuntimePolicy,
  isClaudePromptUuid,
  loggedClaudeQueryOptions,
  makeClaudeAgentSdkProtocolLogger,
} from "./ClaudeAdapterV2.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeCloud");
// The SDK puts no deadline on control requests, and once a session is
// archived its POSTs get 409 and the request never settles.
const CONTROL_TIMEOUT = Duration.seconds(15);
// `initialize` is answered once the session's container is up. Only a new
// session's container boots on its own; a stopped one waits for a prompt.
const INITIALIZE_TIMEOUT = Duration.seconds(60);
// The SDK has already retried for about 30 s when a stream ends in an error.
const MAX_RECONNECTS = 5;
// The session stores a prompt and echoes it back as soon as its POST lands,
// before the worker sees it. No echo means the POST was lost: the SDK drops a
// POST after three failed tries without saying so.
const PROMPT_ECHO_TIMEOUT = Duration.seconds(30);
// A prompt the session still has not stored by then fails the stream, which
// ends its turn instead of leaving it running.
const PROMPT_DELIVERY_DEADLINE = Duration.minutes(2);
// How long an interrupt waits for prompts offered before it to be stored.
const INTERRUPT_PROMPT_WAIT = Duration.seconds(5);
// A worker that fails to start says so only on the session, never on its
// stream, so until the worker shows it started the session is read this
// often, this many times: three minutes.
const START_POLL_INTERVAL = Duration.seconds(5);
const START_POLLS = 36;
const WORKER_START_BUDGET = Duration.times(START_POLL_INTERVAL, START_POLLS);
// The CLI counts a recoverable init error as a failed start once it is this
// old; until then the cloud may still be retrying.
const RECOVERABLE_INIT_ERROR_GRACE_MS = 120_000;
const WORKER_UP_STATUSES = new Set(["running", "idle", "requires_action"]);
// Headers are fixed per query, so a query is replaced before its token
// expires. This lands inside the login reader's expiry margin, so the
// replacement has the CLI refresh the token instead of reading it again.
const LOGIN_REOPEN_LEAD_MS = CLAUDE_CLOUD_LOGIN_EXPIRY_MARGIN_MS - 60_000;
const DEFAULT_TITLE = "T3 Code thread";
const ENV_MANAGER_LOG = "env_manager_log";
const LOCAL_COMMAND_STDOUT = "<local-command-stdout>";

const CONTROL_FAILURES = {
  setModel: "model_change_failed",
  applyFlagSettings: "settings_change_failed",
  setPermissionMode: "permission_mode_change_failed",
  stopTask: "task_stop_failed",
  backgroundTasks: "backgrounding_failed",
  interrupt: "interrupt_failed",
} as const satisfies Record<string, ClaudeCloudFailureReason>;
type ControlMethod = keyof typeof CONTROL_FAILURES;
const LOGIN_FAILURES = {
  missing: "login_missing",
  no_sessions_scope: "login_no_sessions_scope",
  expired: "login_expired",
  unreadable: "login_unreadable",
} as const satisfies Record<ClaudeCloudCredentialsError["reason"], ClaudeCloudFailureReason>;
// How the CLI answers `stop_task` for a task that already ended, or that it
// no longer tracks.
const TASK_ALREADY_ENDED = /No task found|is not running/u;
const MAX_SENT_FILE_BYTES = 256 * 1024 * 1024;
const SENT_FILE_DOWNLOAD_TIMEOUT = Duration.minutes(5);
const FILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BROWSER_SDK = { query: browserQuery, getCcrEvent, getSseLastSequenceNum };

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
const RepositoryChoiceJson = Schema.fromJsonString(ClaudeCloudRepositoryChoice);
const decodeRepositoryChoice = Schema.decodeUnknownEffect(RepositoryChoiceJson);
const encodeRepositoryChoice = Schema.encodeEffect(RepositoryChoiceJson);

type ClaudeFlagSettings = Parameters<Query["applyFlagSettings"]>[0];

export interface ClaudeCloudQueryRunnerOptions {
  readonly api: ClaudeCloudApi;
  /** Trimmed `environmentId` setting; undefined lets the CLI's default or the first cloud env decide. */
  readonly environmentId: string | undefined;
  /** Claude config dir, read for `remote.defaultEnvironmentId`. */
  readonly configDir: string;
  /** Where files the sessions send the user are saved, one folder per thread. */
  readonly filesDir: string;
  /**
   * A thread under "No project" runs in a folder in `scratchRoot` that is not a
   * git repository, so Claude on this machine chooses its repository from the
   * thread's first message.
   */
  readonly withoutProject?: {
    readonly scratchRoot: string;
    readonly chooseRepository: ChooseClaudeCloudRepository;
  };
  /** The browser Agent SDK. Tests replace it. */
  readonly sdk?: {
    readonly query: typeof browserQuery;
    readonly getCcrEvent: typeof getCcrEvent;
    readonly getSseLastSequenceNum: typeof getSseLastSequenceNum;
  };
}

/** What a session was created with, until this process first opens it. */
interface CreatedSession {
  readonly startupNotices: ReadonlyArray<string>;
  readonly model: string;
  readonly effortLevel: EffortLevel | undefined;
  readonly permissionMode: PermissionMode;
}

interface Connection {
  readonly query: Query;
  readonly prompts: Queue.Queue<SDKUserMessage>;
  readonly fromSequenceNum: number;
  /** Holds this query's timers: echo checks and the replacement before its token expires. */
  readonly timers: Scope.Closeable;
}

interface PendingPrompt {
  readonly uuid: string;
  readonly message: SDKUserMessage;
  readonly offeredAt: number;
  readonly stored: Deferred.Deferred<void>;
}

const CLOUD_EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// The cloud stores any effort it is sent, valid or not, and then runs with it.
const isCloudEffortLevel = (effort: string | null | undefined): effort is EffortLevel =>
  effort != null && CLOUD_EFFORT_LEVELS.has(effort);

// Cloud sessions are not launched with --dangerously-skip-permissions, so the
// worker refuses bypassPermissions. Its default mode already approves tools in
// the sandbox through config rules, which is what full access asks for.
const cloudPermissionMode = (mode: PermissionMode): PermissionMode =>
  mode === "bypassPermissions" ? "default" : mode;

const withCloudEffort = (settings: ClaudeFlagSettings): ClaudeFlagSettings => {
  const { effortLevel, ...rest } = settings;
  return effortLevel == null || isCloudEffortLevel(effortLevel) ? settings : rest;
};

const openFlagSettings = (options: ClaudeAgentSdkQueryOptions): ClaudeFlagSettings => {
  const settings = typeof options.settings === "object" ? options.settings : undefined;
  return {
    ...(isCloudEffortLevel(options.effort) ? { effortLevel: options.effort } : {}),
    fastMode: settings?.fastMode ?? null,
    ultracode: settings?.ultracode ?? null,
  };
};

// The browser SDK reports HTTP failures as `SSEHttpError`s carrying the status.
const sseStatus = (failure: unknown) =>
  failure instanceof Error &&
  failure.name === "SSEHttpError" &&
  "code" in failure &&
  typeof failure.code === "number"
    ? failure.code
    : undefined;

// 401s are retried too: the CLI rotates the token, and a reconnect re-reads it.
const isPermanentStreamFailure = (failure: unknown) => {
  const status = sseStatus(failure);
  return status === 403 || status === 404;
};

const connectionFailureReason = (failure: unknown): ClaudeCloudFailureReason => {
  switch (sseStatus(failure)) {
    case 401:
      return "login_rejected";
    case 403:
      return "login_refused";
    case 404:
      return "session_missing";
    default:
      return "connection_lost";
  }
};

const cloudFailureReason = (
  error: ClaudeCloudApiError | ClaudeCloudNoEnvironmentError,
): ClaudeCloudFailureReason => {
  switch (error._tag) {
    case "ClaudeCloudCredentialsError":
      return LOGIN_FAILURES[error.reason];
    case "ClaudeCloudUnauthorizedError":
      return "login_rejected";
    case "ClaudeCloudNotFoundError":
      return error.operation === "listEnvironments" || error.operation === "downloadFile"
        ? "request_failed"
        : "session_missing";
    case "ClaudeCloudConflictError":
      return "session_inactive";
    case "ClaudeCloudRateLimitedError":
      return "rate_limited";
    case "ClaudeCloudHttpError":
      return "request_failed";
    case "ClaudeCloudDecodeError":
      return "unexpected_response";
    case "ClaudeCloudNoEnvironmentError":
      return "no_environment";
  }
};

/**
 * Reads a failed start the way `claude` does, so both agree on a session: a
 * worker that is up has recovered from any earlier error, and bridge sessions
 * are left to their own machine.
 */
const initFailureReason = (
  session: ClaudeCloudSession,
  nowMs: number,
): ClaudeCloudFailureReason | undefined => {
  const error = session.environmentKind === "bridge" ? null : session.lastInitError;
  if (error === null) return undefined;
  if (error.kind === "environment_deleted") return "environment_deleted";
  const workerUp = session.workerStatus !== null && WORKER_UP_STATUSES.has(session.workerStatus);
  const settled =
    !error.recoverable || (error.at !== null && nowMs - error.at > RECOVERABLE_INIT_ERROR_GRACE_MS);
  if (workerUp || !settled) return undefined;
  return error.type === "ref_not_found" ? "branch_not_found" : "session_start_failed";
};

const initFailureCause = (session: ClaudeCloudSession) =>
  `The cloud session's worker failed to start (${session.lastInitError?.type ?? "unknown"}).`;

const cloudError =
  (method: string) =>
  (cause: ClaudeCloudApiError | ClaudeCloudNoEnvironmentError): ClaudeAgentSdkQueryRunnerError =>
    new ClaudeAgentSdkQueryRunnerError({ method, cause, reason: cloudFailureReason(cause) });

// The first reconnect is immediate: the SDK already waited, and a rejected
// login may have been refreshed by the CLI in the meantime.
const reconnectDelay = (attempt: number) => Duration.seconds(2 ** (attempt - 2));

// The browser SDK sends `cancel_queued` when asked (the CLI advertises it as
// interrupt_cancel_queued_v1), but its typings do not declare the option yet.
const interruptCancellingQueued = (query: Query) => {
  const interrupt: (options: { readonly cancelQueued: boolean }) => ReturnType<Query["interrupt"]> =
    query.interrupt.bind(query);
  return interrupt({ cancelQueued: true });
};

const WINDOWS_RESERVED_FILE_NAME_CHARACTERS = '<>:"\\|?*';

/** The container path's last segment, as a name every host's filesystem accepts. */
const sentFileName = (containerPath: string) => {
  const name = [...(containerPath.split("/").pop() ?? "")]
    .map((character) =>
      character < " " || WINDOWS_RESERVED_FILE_NAME_CHARACTERS.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .slice(-120);
  return name.length > 0 ? name : "file";
};

const userText = (message: SDKUserMessage["message"]) =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * The cloud worker can deliver one permission prompt more than once: a
 * replacement query replays it from its cursor, `initialize` redelivers it,
 * and it stays open when the POST carrying the answer was lost. A repeat gets
 * the first answer again, which the worker ignores if it already has it.
 * `null` leaves the prompt open for another client, and an answer cut short by
 * its query closing never reached the worker, so neither is reused.
 */
const answerEachRequestOnce = (canUseTool: CanUseTool): CanUseTool => {
  const answers = new Map<string, Promise<PermissionResult | null>>();
  return async (toolName, toolInput, options) => {
    const earlier = answers.get(options.requestId);
    const answer = earlier === undefined ? null : await earlier;
    if (answer !== null) return answer;
    const decision = canUseTool(toolName, toolInput, options);
    answers.set(
      options.requestId,
      decision.then(
        (result) => (result !== null && !options.signal.aborted ? result : null),
        () => null,
      ),
    );
    return decision;
  };
};

/**
 * Runs Claude Code sessions in Anthropic's cloud through the browser Agent
 * SDK, which drives a session over its SSE event stream with the same `Query`
 * the local runner gets from the CLI. `close` only disconnects; sessions are
 * never archived here.
 */
export const makeClaudeCloudQueryRunner = Effect.fn("makeClaudeCloudQueryRunner")(function* (
  options: ClaudeCloudQueryRunnerOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
  >();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { api, withoutProject } = options;
  const sdk = options.sdk ?? BROWSER_SDK;
  // By `cse_` id; an entry lives from creation until the open that uses it.
  const createdSessions = new Map<string, CreatedSession>();

  const isScratchFolder = (scratchRoot: string, cwd: string) => {
    const relative = path.relative(scratchRoot, cwd);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  /**
   * The repository of a thread under "No project". Claude on this machine
   * chooses it from the thread's first message, and the choice is kept beside
   * the thread's downloads, so a later session for the thread, such as one
   * replacing a session archived on claude.ai, starts from the same place.
   */
  const chosenRepository = Effect.fn("ClaudeCloudQueryRunner.chosenRepository")(function* (
    chooseRepository: ChooseClaudeCloudRepository,
    input: ClaudeAgentSdkSessionAllocateInput,
    cwd: string,
    model: { readonly model: string; readonly effortLevel: EffortLevel | undefined },
  ) {
    const threadFolder = claudeCloudThreadFolder(input.threadId);
    const choiceFile =
      threadFolder === null
        ? null
        : path.join(options.filesDir, threadFolder, CLAUDE_CLOUD_REPOSITORY_CHOICE_FILE_NAME);
    const saved =
      choiceFile === null
        ? Option.none<ClaudeCloudRepositoryChoice>()
        : yield* fileSystem
            .readFileString(choiceFile)
            .pipe(Effect.flatMap(decodeRepositoryChoice), Effect.option);
    const startingPoint = (choice: ClaudeCloudRepositoryChoice) =>
      `\`${choice.repository}\`${choice.branch === null ? "" : ` at \`${choice.branch}\``}`;
    if (Option.isSome(saved)) {
      return {
        choice: saved.value,
        notice: `This thread has no project, so its cloud session starts from ${startingPoint(saved.value)}, which Claude chose when the thread began.`,
      };
    }
    const messageText = input.messageText?.trim() ?? "";
    if (messageText === "") {
      return yield* new ClaudeAgentSdkQueryRunnerError({
        method: "chooseRepository",
        cause: "The thread has no message to choose a repository from.",
        reason: "repository_not_chosen",
      });
    }
    const choice = yield* chooseRepository({ cwd, messageText, ...model }).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeAgentSdkQueryRunnerError({
            method: "chooseRepository",
            cause,
            reason:
              cause.reason === "not_chosen" ? "repository_not_chosen" : "repository_choice_failed",
          }),
      ),
    );
    if (choiceFile !== null) {
      // Without it, a replacement session asks Claude again, from its own message.
      yield* fileSystem.makeDirectory(path.dirname(choiceFile), { recursive: true }).pipe(
        Effect.andThen(encodeRepositoryChoice(choice)),
        Effect.flatMap((json) => fileSystem.writeFileString(choiceFile, json)),
        Effect.catch((error) =>
          Effect.logWarning("Claude Cloud could not save the repository chosen for a thread.", {
            errorTag: error._tag === "PlatformError" ? error.reason._tag : error._tag,
          }),
        ),
      );
    }
    return {
      choice,
      notice: `This thread has no project, so Claude on this machine chose ${startingPoint(choice)}${choice.reason === "" ? "." : `: ${choice.reason}`}`,
    };
  });

  const sessionSource = Effect.fn("ClaudeCloudQueryRunner.sessionSource")(function* (
    input: ClaudeAgentSdkSessionAllocateInput,
    cwd: string,
    model: { readonly model: string; readonly effortLevel: EffortLevel | undefined },
  ) {
    const resolved = yield* Effect.result(
      resolveClaudeCloudRepository(cwd).pipe(Effect.provideContext(context)),
    );
    if (Result.isSuccess(resolved)) {
      return {
        repoUrl: resolved.success.repoUrl,
        revision: resolved.success.revision,
        notices: resolved.success.notices.map((notice) => notice.message),
      };
    }
    const cause = resolved.failure;
    if (
      withoutProject !== undefined &&
      cause._tag === "ClaudeCloudRepositoryError" &&
      cause.reason === "not_a_repository" &&
      isScratchFolder(withoutProject.scratchRoot, cwd)
    ) {
      const { choice, notice } = yield* chosenRepository(
        withoutProject.chooseRepository,
        input,
        cwd,
        model,
      );
      return {
        repoUrl: `https://github.com/${choice.repository}`,
        revision: choice.branch,
        notices: [notice],
      };
    }
    return yield* new ClaudeAgentSdkQueryRunnerError({
      method: "resolveRepository",
      cause,
      reason: cause._tag === "ClaudeCloudRepositoryError" ? cause.reason : "repository_unreadable",
    });
  });

  const allocateSessionId = Effect.fn("ClaudeCloudQueryRunner.allocateSessionId")(function* (
    input: ClaudeAgentSdkSessionAllocateInput,
  ) {
    const cwd = input.runtimePolicy.cwd;
    if (cwd === null) {
      return yield* new ClaudeAgentSdkQueryRunnerError({
        method: "allocateSessionId",
        cause: "The thread has no project folder.",
        reason: "no_project_folder",
      });
    }
    // Before the repository, which Claude may take minutes to choose for a
    // thread without a project.
    const environmentId = yield* resolveClaudeCloudEnvironment({
      environmentId: options.environmentId,
      configDir: options.configDir,
      listEnvironments: api.listEnvironments,
    }).pipe(Effect.provideContext(context), Effect.mapError(cloudError("resolveEnvironment")));
    const selection = compileClaudeModelSelection(input.modelSelection);
    const effortLevel = isCloudEffortLevel(selection.effort) ? selection.effort : undefined;
    const repository = yield* sessionSource(input, cwd, {
      model: selection.apiModelId,
      effortLevel,
    });
    const permissionMode = cloudPermissionMode(
      claudeRuntimeQueryPolicyForRuntimePolicy(input.runtimePolicy).permissionMode,
    );
    const title = input.title ?? DEFAULT_TITLE;
    const session = yield* api
      .createSession({
        title,
        environmentId,
        source: { repoUrl: repository.repoUrl, revision: repository.revision },
        model: selection.apiModelId,
        effortLevel,
        permissionMode,
        // Without an outcome branch the cloud checks out a detached HEAD and
        // has nowhere to push. The server appends a random suffix.
        outcomeBranch: `claude/${sanitizeBranchFragment(title).replaceAll("/", "-")}`,
      })
      .pipe(Effect.mapError(cloudError("createSession")));
    createdSessions.set(session.id, {
      startupNotices: [
        `Running in a Claude Code cloud session: ${session.webUrl}`,
        ...repository.notices,
      ],
      model: selection.apiModelId,
      effortLevel,
      permissionMode,
    });
    return session.id;
  });

  // Fails only for a session that can never take another turn. Anything else
  // is left to the requests that follow, which report it themselves. Returns
  // the session when it could be read.
  const readUsableSession = Effect.fn("ClaudeCloudQueryRunner.readUsableSession")(function* (
    sessionId: string,
  ) {
    const read = yield* Effect.result(api.getSession(sessionId));
    if (Result.isFailure(read)) {
      if (read.failure._tag === "ClaudeCloudNotFoundError") {
        return yield* new ClaudeAgentSdkQueryRunnerError({
          method: "getSession",
          cause: read.failure,
          reason: "session_missing",
        });
      }
      yield* Effect.logWarning("orchestration-v2.claude-cloud-session-status-unavailable", {
        sessionId,
        errorTag: read.failure._tag,
      });
      return;
    }
    const { status } = read.success;
    if (status === "archived" || status === "failed") {
      return yield* new ClaudeAgentSdkQueryRunnerError({
        method: "getSession",
        cause: `The cloud session's status is ${status}.`,
        reason: status === "archived" ? "session_archived" : "session_failed",
      });
    }
    // A session whose worker failed to start stays active.
    const initFailure = initFailureReason(read.success, yield* Clock.currentTimeMillis);
    if (initFailure !== undefined) {
      return yield* new ClaudeAgentSdkQueryRunnerError({
        method: "getSession",
        cause: initFailureCause(read.success),
        reason: initFailure,
      });
    }
    return read.success;
  });
  const assertSessionUsable = (sessionId: string) =>
    readUsableSession(sessionId).pipe(Effect.asVoid);

  const open = Effect.fn("ClaudeCloudQueryRunner.open")(function* (
    input: ClaudeAgentSdkQueryOpenInput,
  ) {
    const queryOptions = input.options;
    const sessionId = queryOptions.sessionId ?? queryOptions.resume;
    const created = createdSessions.get(sessionId);
    const protocolLogger = makeClaudeAgentSdkProtocolLogger({
      nativeEventLogger,
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      driver: DRIVER_KIND,
    });
    // Only these events are logged; the SDK's `sse` options never are, because
    // their headers carry the bearer token.
    const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
      protocolLogger === undefined ? Effect.void : protocolLogger(event);

    // A session this process just created is known to be live; an archived one
    // would otherwise only fail at `initialize`, a minute later.
    const existing = created === undefined ? yield* readUsableSession(sessionId) : undefined;
    // The cloud stops an idle session's container, and only a prompt starts it
    // again: control requests are stored, and the worker answers them in order
    // once it boots, before the prompt that woke it.
    const asleep = existing !== undefined && existing.connectionStatus !== "connected";
    // Starting after the newest stored event keeps history from replaying:
    // the adapter would read old turns as work that finished while it was away.
    const fromSequenceNum = yield* api
      .latestSequenceNum(sessionId)
      .pipe(Effect.mapError(cloudError("latestSequenceNum")));
    const canUseTool =
      queryOptions.canUseTool === undefined
        ? undefined
        : answerEachRequestOnce(queryOptions.canUseTool);
    // Our own prompts come back as client-sourced `user` frames.
    const offered = new Set<string>();
    // Offered prompts the session has not echoed back yet, in offer order. A
    // replacement query sends them all again: the session stores one event
    // per uuid, so a prompt that did arrive is not run twice.
    const unechoed = new Map<string, PendingPrompt>();
    const closeSignal = yield* Deferred.make<void>();
    let closed = false;
    // Why the session takes nothing more: it was closed, or failed for good.
    let ended: ClaudeAgentSdkQueryRunnerError | undefined;
    // The worker's mode as last reported or set, so an unchanged mode costs no
    // round trip; the adapter re-applies its mode before every prompt.
    let permissionMode: PermissionMode | undefined = created?.permissionMode;
    // Done once the worker answers `initialize` or sends a frame of its own.
    const started = yield* Deferred.make<void>();

    // Headers are fixed per query, so each (re)connect reads the login again.
    const connect = Effect.fnUntraced(function* (cursor: number) {
      const transport = yield* api
        .sessionTransport(sessionId)
        .pipe(Effect.mapError(cloudError("sessionTransport")));
      const prompts = yield* Queue.unbounded<SDKUserMessage>();
      const prompt = Stream.fromQueue(prompts).pipe(
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );
      // The browser query has no cwd, env, executable, system prompt or resume
      // point, and it throws on MCP servers other than in-process ones.
      const query = yield* Effect.try({
        try: () =>
          sdk.query({
            prompt,
            sse: {
              streamUrl: transport.streamUrl,
              sendUrl: transport.sendUrl,
              sessionId: transport.sessionId,
              headers: { ...transport.headers },
              fromSequenceNum: cursor,
            },
            ...(canUseTool === undefined ? {} : { canUseTool }),
            ...(queryOptions.onUserDialog === undefined
              ? {}
              : { onUserDialog: queryOptions.onUserDialog }),
          }),
        catch: (cause) =>
          new ClaudeAgentSdkQueryRunnerError({ method: "query", cause, reason: "connection_lost" }),
      });
      yield* logProtocolEvent({
        direction: "outgoing",
        stage: "decoded",
        payload: { type: "query.open", options: loggedClaudeQueryOptions(queryOptions) },
      });
      const connection = {
        query,
        prompts,
        fromSequenceNum: cursor,
        timers: yield* Scope.make(),
      } satisfies Connection;
      const reopenInMs =
        transport.expiresAt === null
          ? undefined
          : transport.expiresAt - LOGIN_REOPEN_LEAD_MS - (yield* Clock.currentTimeMillis);
      if (reopenInMs !== undefined && reopenInMs > 0) {
        yield* startTimer(
          connection,
          Duration.millis(reopenInMs),
          Effect.suspend(() => reopen(connection, "login-expiring")),
        );
      }
      return connection;
    });

    // Started at once, so its sleep is armed before the caller goes on.
    const startTimer = (
      connection: Connection,
      delay: Duration.Duration,
      effect: Effect.Effect<void>,
    ) =>
      Effect.sleep(delay).pipe(
        Effect.andThen(effect),
        Effect.forkIn(connection.timers, { startImmediately: true }),
        Effect.asVoid,
      );

    const disconnect = (connection: Connection) =>
      Queue.shutdown(connection.prompts).pipe(
        Effect.andThen(
          Effect.try({
            try: () => connection.query.close(),
            catch: (cause) =>
              new ClaudeAgentSdkQueryRunnerError({
                method: "close",
                cause,
                reason: "connection_lost",
              }),
          }),
        ),
      );

    let current: Connection = yield* connect(fromSequenceNum);
    // The query controls go to. A reconnect swaps in a pending one, so a
    // control issued meanwhile waits for the replacement instead of failing
    // on the closed query.
    let ready = yield* Deferred.make<Connection, ClaudeAgentSdkQueryRunnerError>();
    yield* Deferred.succeed(ready, current);

    const end = (error: ClaudeAgentSdkQueryRunnerError) =>
      Effect.suspend(() => {
        ended ??= error;
        if (Deferred.isDoneUnsafe(ready)) ready = Deferred.makeUnsafe();
        return Deferred.fail(ready, ended);
      }).pipe(Effect.asVoid);

    // A session whose worker never started takes nothing more, and its query
    // and timers have nothing left to wait for.
    const abandon = (error: ClaudeAgentSdkQueryRunnerError) =>
      end(error).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            disconnect(current).pipe(
              Effect.ignore,
              Effect.ensuring(Scope.close(current.timers, Exit.void)),
            ),
          ),
        ),
      );

    // Whether the session's container is attached. Fails for a start that
    // failed, and for a session deleted or archived while it started.
    const checkStart = Effect.gen(function* () {
      const read = yield* Effect.result(api.getSession(sessionId));
      if (Result.isFailure(read)) {
        if (read.failure._tag === "ClaudeCloudNotFoundError") {
          return yield* cloudError("getSession")(read.failure);
        }
        yield* Effect.logWarning("orchestration-v2.claude-cloud-session-status-unavailable", {
          sessionId,
          errorTag: read.failure._tag,
        });
        return false;
      }
      const session = read.success;
      const reason =
        session.status === "archived"
          ? "session_archived"
          : session.status === "failed"
            ? "session_start_failed"
            : initFailureReason(session, yield* Clock.currentTimeMillis);
      if (reason !== undefined) {
        return yield* new ClaudeAgentSdkQueryRunnerError({
          method: "getSession",
          cause:
            reason === "session_archived" || reason === "session_start_failed"
              ? `The cloud session's status is ${session.status}.`
              : initFailureCause(session),
          reason,
        });
      }
      return session.connectionStatus === "connected";
    });

    // Without it, a turn on a worker that never starts would run forever. It
    // stops at the first read after the worker shows it started.
    const watchStart = Effect.gen(function* () {
      let attached = false;
      for (let poll = 0; poll < START_POLLS; poll += 1) {
        yield* Effect.sleep(START_POLL_INTERVAL);
        if (Deferred.isDoneUnsafe(started)) return;
        attached = yield* checkStart;
      }
      // An attached container may still be booting (a setup script can run
      // for minutes), or hold a worker that is only quiet, so it is left to
      // the stream.
      if (!attached && !Deferred.isDoneUnsafe(started)) {
        return yield* new ClaudeAgentSdkQueryRunnerError({
          method: "watchStart",
          cause: `No worker frame within ${Duration.format(WORKER_START_BUDGET)}.`,
          reason: "session_start_timed_out",
        });
      }
    });
    // Fails, and only fails, when the start does.
    const startFailure = yield* Deferred.make<never, ClaudeAgentSdkQueryRunnerError>();
    const startWatch = yield* Scope.make();
    // Started at once, so its first sleep is armed before `open` returns. The
    // failure is out before the query closes, so whatever waits on both (an
    // `initialize`) reports the failed start, not the closed query.
    yield* watchStart.pipe(
      Effect.catch((error) =>
        Deferred.fail(startFailure, error).pipe(Effect.andThen(abandon(error))),
      ),
      Effect.forkIn(startWatch, { startImmediately: true }),
    );

    // Ends a query's stream; the stream then replaces it, unless the session ended.
    const retire = (connection: Connection) =>
      Effect.suspend(() => {
        if (ended === undefined && current === connection && Deferred.isDoneUnsafe(ready)) {
          ready = Deferred.makeUnsafe();
        }
        return disconnect(connection).pipe(Effect.ignore);
      });

    const send = Effect.fnUntraced(function* (connection: Connection, prompt: PendingPrompt) {
      if (yield* Queue.offer(connection.prompts, prompt.message)) {
        yield* startTimer(connection, PROMPT_ECHO_TIMEOUT, checkEcho(connection, prompt.uuid));
      }
    });

    const control = <A>(method: ControlMethod, run: (query: Query) => Promise<A>) =>
      Effect.suspend(() => Deferred.await(ready)).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () => run(connection.query),
            catch: (cause) =>
              new ClaudeAgentSdkQueryRunnerError({
                method,
                cause,
                reason:
                  sseStatus(cause) === undefined
                    ? CONTROL_FAILURES[method]
                    : connectionFailureReason(cause),
              }),
          }),
        ),
        Effect.timeoutOrElse({
          duration: CONTROL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ClaudeAgentSdkQueryRunnerError({
                method,
                cause: `No answer to ${method} within ${Duration.format(CONTROL_TIMEOUT)}.`,
                reason: "control_timed_out",
              }),
            ),
        }),
      );

    const setPermissionMode = (mode: PermissionMode) => {
      const cloudMode = cloudPermissionMode(mode);
      return Effect.suspend(() =>
        cloudMode === permissionMode
          ? Effect.void
          : control("setPermissionMode", (query) => query.setPermissionMode(cloudMode)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  permissionMode = cloudMode;
                }),
              ),
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: { type: "query.set_permission_mode", mode: cloudMode },
                }),
              ),
            ),
      );
    };
    const setModel = (model: string) =>
      control("setModel", (query) => query.setModel(model)).pipe(
        Effect.tap(() =>
          logProtocolEvent({
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.set_model", model },
          }),
        ),
      );
    const applyFlagSettings = (settings: ClaudeFlagSettings) =>
      control("applyFlagSettings", (query) => query.applyFlagSettings(settings)).pipe(
        Effect.tap(() =>
          logProtocolEvent({
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.apply_flag_settings", settings },
          }),
        ),
      );

    // Sends each control at once, in order, and takes its answer whenever the
    // worker gives it. One left unanswered is only logged: the adapter sets
    // the mode again before a prompt, and the session keeps its last model.
    const sendControlsUnanswered = Effect.fn("ClaudeCloudQueryRunner.sendControlsUnanswered")(
      function* (
        controls: ReadonlyArray<{
          readonly method: ControlMethod;
          readonly send: (query: Query) => Promise<unknown>;
          readonly answered: Effect.Effect<void>;
        }>,
      ) {
        const query = current.query;
        const answers = controls.map((entry) => {
          const answer = entry.send(query);
          // Settled now, so a rejection before the fork below reads it is handled.
          answer.catch(() => undefined);
          return { ...entry, answer };
        });
        yield* Effect.forEach(
          answers,
          ({ method, answer, answered }) =>
            Effect.tryPromise({
              try: () => answer,
              catch: (cause) =>
                new ClaudeAgentSdkQueryRunnerError({
                  method,
                  cause,
                  reason: CONTROL_FAILURES[method],
                }),
            }).pipe(
              Effect.timeout(Duration.sum(WORKER_START_BUDGET, CONTROL_TIMEOUT)),
              Effect.andThen(answered),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration-v2.claude-cloud-wake-control-unanswered", {
                  sessionId,
                  method,
                  cause,
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.forkIn(startWatch, { startImmediately: true }));
      },
    );

    // A session this process just created already runs with the selection it
    // was created with; its container is still booting, so controls would
    // only wait on that.
    const flags = openFlagSettings(queryOptions);
    const setModelOnOpen = created?.model !== queryOptions.model;
    const applyFlagsOnOpen =
      created === undefined ||
      created.effortLevel !== flags.effortLevel ||
      flags.fastMode === true ||
      flags.ultracode === true;
    const setPermissionModeOnOpen =
      cloudPermissionMode(queryOptions.permissionMode) !== permissionMode;
    if (asleep) {
      // Nothing answers until the prompt the adapter offers next boots the
      // worker, so waiting here would only time out. Sent before that prompt,
      // the controls still apply to its turn. The SDK sends `initialize` itself.
      const mode = cloudPermissionMode(queryOptions.permissionMode);
      yield* sendControlsUnanswered([
        ...(setPermissionModeOnOpen
          ? [
              {
                method: "setPermissionMode" as const,
                send: (query: Query) => query.setPermissionMode(mode),
                answered: Effect.sync(() => {
                  permissionMode = mode;
                }).pipe(
                  Effect.andThen(
                    logProtocolEvent({
                      direction: "outgoing",
                      stage: "decoded",
                      payload: { type: "query.set_permission_mode", mode },
                    }),
                  ),
                ),
              },
            ]
          : []),
        ...(setModelOnOpen
          ? [
              {
                method: "setModel" as const,
                send: (query: Query) => query.setModel(queryOptions.model),
                answered: logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: { type: "query.set_model", model: queryOptions.model },
                }),
              },
            ]
          : []),
        ...(applyFlagsOnOpen
          ? [
              {
                method: "applyFlagSettings" as const,
                send: (query: Query) => query.applyFlagSettings(flags),
                answered: logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: { type: "query.apply_flag_settings", settings: flags },
                }),
              },
            ]
          : []),
      ]);
    } else if (setModelOnOpen || applyFlagsOnOpen || setPermissionModeOnOpen) {
      yield* Effect.gen(function* () {
        // The SDK sends `initialize` on its own. Waiting for it fails an
        // unusable login or session here rather than in the first turn.
        yield* Effect.tryPromise({
          try: () => current.query.initializationResult(),
          catch: (cause) =>
            new ClaudeAgentSdkQueryRunnerError({
              method: "initialize",
              cause,
              reason: connectionFailureReason(cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: INITIALIZE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ClaudeAgentSdkQueryRunnerError({
                  method: "initialize",
                  cause: `No answer to initialize within ${Duration.format(INITIALIZE_TIMEOUT)}.`,
                  reason: "session_start_timed_out",
                }),
              ),
          }),
          // A worker that fails to boot never answers, so this tells why sooner.
          Effect.raceFirst(Deferred.await(startFailure)),
        );
        yield* Deferred.succeed(started, undefined);
        yield* Effect.all(
          [
            setPermissionMode(queryOptions.permissionMode),
            (setModelOnOpen ? setModel(queryOptions.model) : Effect.void).pipe(
              Effect.andThen(applyFlagsOnOpen ? applyFlagSettings(flags) : Effect.void),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(
        Effect.onError(() =>
          disconnect(current).pipe(
            Effect.ignore,
            Effect.andThen(Scope.close(current.timers, Exit.void)),
            Effect.andThen(Scope.close(startWatch, Exit.void)),
          ),
        ),
      );
    }
    createdSessions.delete(sessionId);

    const ownEchoUuid = (query: Query, message: SDKMessage) =>
      message.type === "user" &&
      message.uuid !== undefined &&
      offered.has(message.uuid) &&
      sdk.getCcrEvent(query, message)?.source === "client"
        ? message.uuid
        : undefined;

    // `setModel` makes the worker replay the `/model` command's output into
    // the transcript. T3 shows none of it, and between turns the adapter would
    // keep it as evidence of a turn nobody started.
    const isLocalCommandReplay = (query: Query, message: SDKMessage) =>
      message.type === "user" &&
      "isReplay" in message &&
      message.isReplay === true &&
      message.parent_tool_use_id === null &&
      userText(message.message).startsWith(LOCAL_COMMAND_STDOUT) &&
      sdk.getCcrEvent(query, message)?.source === "worker";

    // The container logs its boot before the worker runs, and client frames
    // are prompts coming back, so neither shows that the worker started. Nor
    // does turn output: when the checkout fails, the cloud itself sends a
    // `<synthetic>` assistant message and a result as the worker, and a
    // worker that did start says so before any of its turns.
    const showsWorkerStarted = (query: Query, message: SDKMessage) => {
      const type: string = message.type;
      return (
        type !== ENV_MANAGER_LOG &&
        type !== "result" &&
        !(message.type === "assistant" && message.message?.model === "<synthetic>") &&
        sdk.getCcrEvent(query, message)?.source !== "client"
      );
    };

    const forwards = (query: Query, message: SDKMessage) => {
      const type: string = message.type;
      return (
        type !== ENV_MANAGER_LOG &&
        ownEchoUuid(query, message) === undefined &&
        !isLocalCommandReplay(query, message)
      );
    };

    const trackPermissionMode = (message: SDKMessage) => {
      if (
        message.type === "system" &&
        (message.subtype === "init" || message.subtype === "status") &&
        message.permissionMode !== undefined
      ) {
        permissionMode = message.permissionMode;
      }
    };

    // Queries retired on purpose; their replacement is no failed attempt.
    const reopened = new WeakSet<Connection>();
    const reopen = (connection: Connection, reason: "prompt-unechoed" | "login-expiring") =>
      Effect.logInfo("orchestration-v2.claude-cloud-query-reopening", { sessionId, reason }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            reopened.add(connection);
            return retire(connection);
          }),
        ),
      );

    const checkEcho = Effect.fnUntraced(function* (connection: Connection, uuid: string) {
      const prompt = unechoed.get(uuid);
      if (prompt === undefined) return;
      const waited = (yield* Clock.currentTimeMillis) - prompt.offeredAt;
      if (waited >= Duration.toMillis(PROMPT_DELIVERY_DEADLINE)) {
        yield* end(
          new ClaudeAgentSdkQueryRunnerError({
            method: "offer",
            cause: `The session did not store the prompt within ${Duration.format(PROMPT_DELIVERY_DEADLINE)}.`,
            reason: "message_not_received",
          }),
        );
      }
      yield* reopen(connection, "prompt-unechoed");
    });

    // `failedAttempts` counts reconnects since a query last delivered anything.
    const attach = (
      connection: Connection,
      failedAttempts: number,
    ): Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError> =>
      Stream.suspend(() => {
        let delivered = false;
        let failure: ClaudeAgentSdkQueryRunnerError | undefined;
        return Stream.fromAsyncIterable(
          claudeQueryMessages(connection.query),
          (cause) =>
            new ClaudeAgentSdkQueryRunnerError({
              method: "messages",
              cause,
              reason: connectionFailureReason(cause),
            }),
        ).pipe(
          Stream.tap((message) =>
            Effect.suspend(() => {
              delivered = true;
              if (showsWorkerStarted(connection.query, message)) {
                Deferred.doneUnsafe(started, Exit.void);
              }
              trackPermissionMode(message);
              const echoed = ownEchoUuid(connection.query, message);
              const stored = echoed === undefined ? undefined : unechoed.get(echoed);
              if (stored !== undefined) {
                unechoed.delete(stored.uuid);
                Deferred.doneUnsafe(stored.stored, Exit.void);
              }
              return logProtocolEvent({
                direction: "incoming",
                stage: "decoded",
                payload: message,
              });
            }),
          ),
          Stream.filter((message) => forwards(connection.query, message)),
          Stream.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (!isClaudeAgentSdkQueryRunnerError(error)) return Stream.failCause(cause);
            failure = error;
            return Stream.empty;
          }),
          Stream.concat(
            Stream.unwrap(
              Effect.suspend(() =>
                reconnect(
                  connection,
                  delivered || reopened.has(connection) ? 1 : failedAttempts + 1,
                  failure,
                ),
              ),
            ),
          ),
        );
      });

    // A query ends early when the SDK gives up reconnecting, its login is
    // rejected, or it is retired above. Its replacement resumes after the last
    // message it delivered.
    const reconnect = Effect.fnUntraced(function* (
      previous: Connection,
      attempt: number,
      failure: ClaudeAgentSdkQueryRunnerError | undefined,
    ) {
      if (closed) return Stream.empty;
      const cursor = sdk.getSseLastSequenceNum(previous.query) ?? previous.fromSequenceNum;
      yield* retire(previous);
      yield* Scope.close(previous.timers, Exit.void);
      const terminal =
        ended ??
        (isPermanentStreamFailure(failure?.cause) || attempt > MAX_RECONNECTS
          ? (failure ??
            new ClaudeAgentSdkQueryRunnerError({
              method: "messages",
              cause: "The Claude Code cloud session stream kept ending.",
              reason: "connection_lost",
            }))
          : undefined);
      if (terminal !== undefined) {
        yield* end(terminal);
        return Stream.fail(terminal);
      }
      yield* Effect.logWarning("orchestration-v2.claude-cloud-query-reconnecting", {
        sessionId,
        attempt,
        cause: failure?.cause,
      });
      if (attempt > 1) {
        yield* Effect.sleep(reconnectDelay(attempt)).pipe(
          Effect.raceFirst(Deferred.await(closeSignal)),
        );
      }
      if (closed) return Stream.empty;
      // A session archived on claude.ai still streams, but drops every POST.
      const connection = yield* assertSessionUsable(sessionId).pipe(
        Effect.andThen(connect(cursor)),
        Effect.tapError(end),
      );
      // Swapped together with the snapshot, so a prompt offered from here on
      // goes straight to the new query and none is sent twice.
      current = connection;
      const resend = [...unechoed.values()];
      // Prompts go before waiting controls, in the order they were issued. An
      // interrupt waiting here has already dropped the prompts it gave up on.
      yield* Effect.forEach(resend, (prompt) => send(connection, prompt), { discard: true });
      yield* Deferred.succeed(ready, connection);
      if (closed) {
        yield* disconnect(connection).pipe(Effect.ignore);
        yield* Scope.close(connection.timers, Exit.void);
        return Stream.empty;
      }
      return attach(connection, attempt);
    });

    return {
      messages: attach(current, 0).pipe(
        Stream.merge(Stream.fromEffect(Deferred.await(startFailure)), { haltStrategy: "left" }),
      ),
      offer: Effect.fn("ClaudeCloudQueryRunner.offer")(function* (message) {
        if (ended !== undefined) return yield* ended;
        // The SDK stamps a uuid on a message that has none, after which its
        // echo could not be told apart from a prompt typed on claude.ai.
        const uuid =
          message.uuid ??
          (yield* crypto.randomUUIDv4().pipe(
            Effect.filterOrFail(isClaudePromptUuid),
            Effect.mapError(
              (cause) =>
                new ClaudeAgentSdkQueryRunnerError({
                  method: "offer",
                  cause,
                  reason: "message_not_prepared",
                }),
            ),
          ));
        const prompt = {
          uuid,
          message: message.uuid === undefined ? { ...message, uuid } : message,
          offeredAt: yield* Clock.currentTimeMillis,
          stored: yield* Deferred.make<void>(),
        } satisfies PendingPrompt;
        offered.add(uuid);
        unechoed.set(uuid, prompt);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: { type: "prompt.offer", message: prompt.message },
        });
        // During a reconnect this query's queue is already shut, and the
        // replacement sends the prompt instead.
        yield* send(current, prompt);
      }),
      setModel,
      applyFlagSettings: (settings) => applyFlagSettings(withCloudEffort(settings)),
      setPermissionMode,
      stopTask: (taskId) =>
        control("stopTask", (query) => query.stopTask(taskId)).pipe(
          // A task that already ended, or that the session no longer tracks,
          // has nothing left to stop; refusing would fail every later Stop
          // that still lists it.
          Effect.catchIf(
            (error) => error.cause instanceof Error && TASK_ALREADY_ENDED.test(error.cause.message),
            () => Effect.void,
          ),
          Effect.tap(() =>
            logProtocolEvent({
              direction: "outgoing",
              stage: "decoded",
              payload: { type: "query.stop_task", taskId },
            }),
          ),
        ),
      backgroundTasks: (toolUseId) =>
        control("backgroundTasks", (query) => query.backgroundTasks(toolUseId)).pipe(
          Effect.tap(() =>
            logProtocolEvent({
              direction: "outgoing",
              stage: "decoded",
              payload: { type: "query.background_tasks", toolUseId },
            }),
          ),
        ),
      // Stop in T3 stops the session, as on claude.ai: without `cancelQueued`
      // a prompt queued behind the aborted turn would run anyway.
      interrupt: Effect.gen(function* () {
        // The SDK takes a prompt from its queue a tick after it is offered, so
        // an interrupt sent at once could reach the session first and leave
        // that prompt to run after the Stop.
        const pending = [...unechoed.values()];
        yield* Effect.forEach(pending, (prompt) => Deferred.await(prompt.stored), {
          discard: true,
        }).pipe(Effect.timeoutOption(INTERRUPT_PROMPT_WAIT));
        // One the session still has not stored is not sent again after the
        // Stop, including by a reconnect the interrupt then waits for.
        for (const prompt of pending) unechoed.delete(prompt.uuid);
        const receipt = yield* control("interrupt", interruptCancellingQueued);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: { type: "query.interrupt" },
        });
        if (receipt === undefined) return;
        return {
          stillQueued: receipt.still_queued,
          cancelled: receipt.cancelled ?? [],
        } satisfies ClaudeQueryInterruptReceipt;
      }),
      close: Effect.suspend(() => {
        closed = true;
        return end(
          new ClaudeAgentSdkQueryRunnerError({
            method: "close",
            cause: "The query was closed.",
            reason: "disconnected",
          }),
        ).pipe(
          Effect.andThen(Deferred.succeed(closeSignal, undefined)),
          Effect.andThen(Scope.close(startWatch, Exit.void)),
          Effect.andThen(
            logProtocolEvent({
              direction: "outgoing",
              stage: "decoded",
              payload: { type: "query.close" },
            }),
          ),
          Effect.andThen(
            Effect.suspend(() =>
              disconnect(current).pipe(Effect.ensuring(Scope.close(current.timers, Exit.void))),
            ),
          ),
        );
      }),
      ...(created === undefined ? {} : { startupNotices: created.startupNotices }),
    } satisfies ClaudeAgentSdkQuerySession;
  });

  // The file store keeps a sent file after its session's container is gone, but this copy
  // is what previews read, so it is fetched once and kept.
  const fetchSentFile = Effect.fn("ClaudeCloudQueryRunner.fetchSentFile")(function* (
    input: ClaudeAgentSdkSentFileInput,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!FILE_UUID.test(input.fileUuid)) {
      return yield* new ClaudeAgentSdkQueryRunnerError({
        method: "fetchSentFile",
        cause: "The sent file's id is not a UUID.",
        reason: "unexpected_response",
      });
    }
    const unsaved = (cause: unknown) =>
      new ClaudeAgentSdkQueryRunnerError({
        method: "fetchSentFile",
        cause,
        reason: "sent_file_unsaved",
      });
    const threadFolder = claudeCloudThreadFolder(input.threadId);
    if (threadFolder === null) {
      return yield* unsaved("The thread id can't name a folder.");
    }
    const threadDirectory = path.join(options.filesDir, threadFolder);
    const directory = path.join(threadDirectory, input.fileUuid.toLowerCase());
    const target = path.join(directory, sentFileName(input.path));
    const tooLarge = new ClaudeAgentSdkQueryRunnerError({
      method: "fetchSentFile",
      cause: "The sent file is larger than the download limit.",
      reason: "sent_file_too_large",
    });
    if (yield* fileSystem.exists(target).pipe(Effect.mapError(unsaved))) return target;
    const content = yield* api
      .downloadFile(input.fileUuid)
      .pipe(Effect.mapError(cloudError("fetchSentFile")));
    if (content.sizeBytes !== undefined && content.sizeBytes > MAX_SENT_FILE_BYTES) {
      return yield* tooLarge;
    }
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unsaved));
    const partial = path.join(threadDirectory, claudeCloudPartialFileName(input.fileUuid));
    let received = 0;
    yield* content.stream.pipe(
      Stream.mapEffect((chunk) => {
        received += chunk.byteLength;
        return received > MAX_SENT_FILE_BYTES ? Effect.fail(tooLarge) : Effect.succeed(chunk);
      }),
      Stream.run(fileSystem.sink(partial)),
      Effect.timeout(SENT_FILE_DOWNLOAD_TIMEOUT),
      Effect.mapError((cause) => {
        switch (cause._tag) {
          case "ClaudeAgentSdkQueryRunnerError":
            return cause;
          case "ClaudeCloudHttpError":
            return cloudError("fetchSentFile")(cause);
          case "PlatformError":
            return unsaved(cause);
          case "TimeoutError":
            return new ClaudeAgentSdkQueryRunnerError({
              method: "fetchSentFile",
              cause,
              reason: "request_failed",
            });
        }
      }),
      Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
    );
    yield* fileSystem.rename(partial, target).pipe(Effect.mapError(unsaved));
    return target;
  });

  return ClaudeAgentSdkQueryRunner.of({
    // A cloud session is created for its thread, so the adapter always uses
    // allocateSessionIdFor here.
    allocateSessionId: Effect.fail(
      new ClaudeAgentSdkQueryRunnerError({
        method: "allocateSessionId",
        cause: "A Claude Code cloud session needs the thread it is for.",
      }),
    ),
    allocateSessionIdFor: allocateSessionId,
    open,
    checkResumable: assertSessionUsable,
    fetchSentFile: (input) => fetchSentFile(input).pipe(Effect.provideContext(context)),
    forkSession: () =>
      Effect.fail(
        new ClaudeAgentSdkQueryRunnerError({
          method: "forkSession",
          cause: "Claude Code cloud sessions cannot be forked.",
          reason: "fork_unsupported",
        }),
      ),
    // Subagent transcripts live in the session's container.
    subagentLaunchToolUseId: () => Effect.succeed(null),
    assertComplete: Effect.void,
  });
});
