import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import type { ClaudeCloudCredentialsError, ClaudeCloudLogin } from "./ClaudeCloudCredentials.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
// The worker treats prompts as the signed-in user's own only from person-facing platforms (CLI,
// IDEs, claude.ai, apps). Any other value, `t3code` included, demotes them to a peer session and
// drops the `user_message_uuid(s)` stamps turns are matched by, so T3 presents itself as the
// user's Claude Code client, as `claude --cloud` does.
const CLIENT_PLATFORM = "claude_code_cli";
const REQUEST_TIMEOUT = "30 seconds";
const ENVIRONMENT_PAGE_SIZE = 100;
const MAX_ENVIRONMENT_PAGES = 20;
const ERROR_TYPE = /^[a-z0-9_]{1,64}$/;

const Operation = Schema.Literals([
  "listEnvironments",
  "createSession",
  "getSession",
  "listEvents",
  "downloadFile",
]);
type Operation = typeof Operation.Type;

const OPERATION_LABELS: Record<Operation, string> = {
  listEnvironments: "listing cloud environments",
  createSession: "creating the cloud session",
  getSession: "reading the cloud session",
  listEvents: "reading the cloud session's events",
  downloadFile: "downloading a file the cloud session sent",
};

export class ClaudeCloudUnauthorizedError extends Schema.TaggedError<ClaudeCloudUnauthorizedError>()(
  "ClaudeCloudUnauthorizedError",
  { operation: Operation, status: Schema.Number },
) {
  override get message(): string {
    return "Claude rejected the Claude login. Run `claude` once to refresh it, or sign in again with `claude auth login`.";
  }
}

export class ClaudeCloudNotFoundError extends Schema.TaggedError<ClaudeCloudNotFoundError>()(
  "ClaudeCloudNotFoundError",
  { operation: Operation },
) {
  override get message(): string {
    switch (this.operation) {
      case "listEnvironments":
        return "Claude Cloud could not find the cloud environments.";
      case "downloadFile":
        return "Claude Cloud could not find the file the cloud session sent.";
      default:
        return "The Claude Code cloud session no longer exists.";
    }
  }
}

export class ClaudeCloudConflictError extends Schema.TaggedError<ClaudeCloudConflictError>()(
  "ClaudeCloudConflictError",
  { operation: Operation, errorType: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return "The Claude Code cloud session is no longer active.";
  }
}

export class ClaudeCloudRateLimitedError extends Schema.TaggedError<ClaudeCloudRateLimitedError>()(
  "ClaudeCloudRateLimitedError",
  { operation: Operation, retryAfterMs: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return "Claude Cloud is rate limiting requests. Try again soon.";
  }
}

/** Any other status, or no response at all (`status` absent). */
export class ClaudeCloudHttpError extends Schema.TaggedError<ClaudeCloudHttpError>()(
  "ClaudeCloudHttpError",
  {
    operation: Operation,
    status: Schema.optional(Schema.Number),
    errorType: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Claude Cloud failed while ${OPERATION_LABELS[this.operation]}${status}.`;
  }
}

export class ClaudeCloudDecodeError extends Schema.TaggedError<ClaudeCloudDecodeError>()(
  "ClaudeCloudDecodeError",
  { operation: Operation, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude Cloud sent an unexpected response while ${OPERATION_LABELS[this.operation]}.`;
  }
}

export type ClaudeCloudApiError =
  | ClaudeCloudCredentialsError
  | ClaudeCloudUnauthorizedError
  | ClaudeCloudNotFoundError
  | ClaudeCloudConflictError
  | ClaudeCloudRateLimitedError
  | ClaudeCloudHttpError
  | ClaudeCloudDecodeError;

/** `cse_X` and `session_X` name the same session; `/v1/code/*` speaks `cse_`. */
export const toCse = (sessionId: string) =>
  sessionId.startsWith("session_") ? `cse_${sessionId.slice("session_".length)}` : sessionId;

/** claude.ai links use the `session_` form. */
export const toSession = (sessionId: string) =>
  sessionId.startsWith("cse_") ? `session_${sessionId.slice("cse_".length)}` : sessionId;

export const claudeCloudWebUrl = (sessionId: string) =>
  `https://claude.ai/code/${toSession(sessionId)}`;

const sessionPath = (sessionId: string) =>
  `/v1/code/sessions/${encodeURIComponent(toCse(sessionId))}`;

/** The SSE read and POST write endpoints the Agent SDK's `sse` transport takes. */
export const sessionUrls = (baseUrl: string, sessionId: string) => ({
  streamUrl: `${baseUrl}${sessionPath(sessionId)}/events/stream`,
  sendUrl: `${baseUrl}${sessionPath(sessionId)}/events`,
});

export interface ClaudeCloudEnvironment {
  readonly id: string;
  /** `anthropic_cloud | bridge | byoc | snap | ccs`, kept open for new kinds. */
  readonly kind: string;
}

/**
 * Why the session's worker last failed to start. The server's own message is
 * left out: it can quote the repository and branch.
 */
export interface ClaudeCloudSessionInitError {
  /** e.g. `source_processing` or `environment_deleted`; null when absent or malformed. */
  readonly kind: string | null;
  /** e.g. `ref_not_found`; null when absent or malformed. */
  readonly type: string | null;
  /** The server says `"true"` or `"false"`. */
  readonly recoverable: boolean;
  /** When it happened, in epoch milliseconds; null when absent or unparseable. */
  readonly at: number | null;
}

export interface ClaudeCloudSession {
  /** Always the `cse_` form. */
  readonly id: string;
  /** `active | paused | archived | failed` */
  readonly status: string | null;
  /** `https://claude.ai/code/session_…`, the form the claude.ai session list uses. */
  readonly webUrl: string;
  /**
   * `connected | disconnected`: whether the session's container is attached.
   * Its environment runner attaches before the worker starts, and stays
   * attached when the worker fails to start.
   */
  readonly connectionStatus: string | null;
  /** `running | idle | requires_action | WORKER_STATUS_UNSPECIFIED` */
  readonly workerStatus: string | null;
  /** `anthropic_cloud | bridge | byoc | …` */
  readonly environmentKind: string | null;
  readonly lastInitError: ClaudeCloudSessionInitError | null;
}

export interface ClaudeCloudCreateSessionInput {
  readonly title: string;
  /** `ccpool_…` ids are self-hosted runner pools and are sent as such. */
  readonly environmentId: string;
  readonly source: {
    /** `https://github.com/<owner>/<repo>` */
    readonly repoUrl: string;
    /** Branch, tag or SHA to check out; null lets the server use the default branch. */
    readonly revision: string | null;
  };
  readonly model?: string | undefined;
  readonly effortLevel?: string | undefined;
  /** Sent as an initial `set_permission_mode` control request. */
  readonly permissionMode?: string | undefined;
  /** Branch the session pushes to; the server appends a random suffix. */
  readonly outcomeBranch?: string | undefined;
}

/** The body of a file a session sent the user, as it arrives. */
export interface ClaudeCloudFileContent {
  /** The `content-length` header, when the server sent one. */
  readonly sizeBytes: number | undefined;
  readonly stream: Stream.Stream<Uint8Array, ClaudeCloudHttpError>;
}

/**
 * What the Agent SDK's `query({ sse })` needs. `headers` carries the bearer
 * token in plain text for the SDK: pass it on, never log or persist it.
 */
export interface ClaudeCloudSessionTransport {
  readonly sessionId: string;
  readonly streamUrl: string;
  readonly sendUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  /** When the token in `headers` expires, in epoch milliseconds; null when the store does not say. */
  readonly expiresAt: number | null;
}

export interface ClaudeCloudApi {
  readonly listEnvironments: Effect.Effect<
    ReadonlyArray<ClaudeCloudEnvironment>,
    ClaudeCloudApiError
  >;
  readonly createSession: (
    input: ClaudeCloudCreateSessionInput,
  ) => Effect.Effect<ClaudeCloudSession, ClaudeCloudApiError>;
  readonly getSession: (
    sessionId: string,
  ) => Effect.Effect<ClaudeCloudSession, ClaudeCloudApiError>;
  /** The newest stored event's `sequence_num`, or 0 for a session with no events. */
  readonly latestSequenceNum: (sessionId: string) => Effect.Effect<number, ClaudeCloudApiError>;
  /** A file a session sent the user with SendUserFile, by the `file_uuid` its result names. */
  readonly downloadFile: (
    fileUuid: string,
  ) => Effect.Effect<ClaudeCloudFileContent, ClaudeCloudApiError>;
  /** Re-reads the login, so call it for every (re)connect. */
  readonly sessionTransport: (
    sessionId: string,
  ) => Effect.Effect<ClaudeCloudSessionTransport, ClaudeCloudCredentialsError>;
}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const EnvironmentRecord = Schema.Struct({
  environment_id: Schema.String,
  kind: Schema.String,
});
const decodeEnvironmentRecord = Schema.decodeUnknownOption(EnvironmentRecord);
const EnvironmentPage = Schema.Struct({
  environments: Schema.Array(Schema.Unknown),
  has_more: Schema.optional(Schema.NullOr(Schema.Boolean)),
  last_id: OptionalString,
});

const SessionRecord = Schema.Struct({
  id: Schema.String,
  status: OptionalString,
  // Read field by field below, so a shape change in what only reports on the
  // worker cannot fail every read of the session.
  connection_status: Schema.optional(Schema.Unknown),
  worker_status: Schema.optional(Schema.Unknown),
  environment_kind: Schema.optional(Schema.Unknown),
  external_metadata: Schema.optional(Schema.Unknown),
});
type SessionRecord = typeof SessionRecord.Type;
const InitErrorHolder = Schema.Struct({
  last_init_error: Schema.Struct({
    error_kind: Schema.optional(Schema.Unknown),
    error_type: Schema.optional(Schema.Unknown),
    recoverable: Schema.optional(Schema.Unknown),
    at: Schema.optional(Schema.Unknown),
  }),
});
const decodeInitErrorHolder = Schema.decodeUnknownOption(InitErrorHolder);
// GET wraps the session in `response_shape`; create uses `session`.
const SessionEnvelope = Schema.Struct({
  session: Schema.optional(SessionRecord),
  response_shape: Schema.optional(SessionRecord),
});

const SequenceNum = Schema.Union([Schema.String, Schema.Number]);
const EventPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ sequence_num: SequenceNum })),
});

const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.NullOr(Schema.Struct({ type: OptionalString }))),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const textOrNull = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;
// Only short identifiers, since they end up in logs and failure reasons.
const errorTypeOrNull = (value: unknown) =>
  typeof value === "string" && ERROR_TYPE.test(value) ? value : null;

const initErrorFrom = (metadata: unknown): ClaudeCloudSessionInitError | null =>
  decodeInitErrorHolder(metadata).pipe(
    Option.map(({ last_init_error: error }) => {
      const at = typeof error.at === "string" ? Date.parse(error.at) : Number.NaN;
      return {
        kind: errorTypeOrNull(error.error_kind),
        type: errorTypeOrNull(error.error_type),
        recoverable: String(error.recoverable) === "true",
        at: Number.isFinite(at) ? at : null,
      };
    }),
    Option.getOrNull,
  );

const sessionFromRecord = (record: SessionRecord): ClaudeCloudSession => ({
  id: toCse(record.id),
  status: record.status ?? null,
  webUrl: claudeCloudWebUrl(record.id),
  connectionStatus: textOrNull(record.connection_status),
  workerStatus: textOrNull(record.worker_status),
  environmentKind: textOrNull(record.environment_kind),
  lastInitError: initErrorFrom(record.external_metadata),
});

const githubRepository = (repoUrl: string) => {
  try {
    const url = new URL(repoUrl);
    return url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  } catch {
    return repoUrl;
  }
};

const requestHeaders = (login: ClaudeCloudLogin, userAgent: string): Record<string, string> => ({
  authorization: `Bearer ${Redacted.value(login.accessToken)}`,
  "anthropic-version": ANTHROPIC_VERSION,
  "anthropic-client-platform": CLIENT_PLATFORM,
  "user-agent": userAgent,
  ...(login.organizationUuid ? { "x-organization-uuid": login.organizationUuid } : {}),
});

/** Accepts both forms RFC 9110 allows: delay seconds or an HTTP date. */
const retryAfterMs = (value: string | undefined, nowMs: number) => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
};

const readErrorType = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) =>
      decodeErrorBody(json).pipe(
        Option.flatMap((body) => Option.fromNullishOr(body.error?.type)),
        Option.filter((type) => ERROR_TYPE.test(type)),
        Option.getOrUndefined,
      ),
    ),
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

const failForStatus = Effect.fn("ClaudeCloudApi.failForStatus")(function* (
  operation: Operation,
  response: HttpClientResponse.HttpClientResponse,
) {
  const status = response.status;
  if (status === 401 || status === 403) {
    return yield* new ClaudeCloudUnauthorizedError({ operation, status });
  }
  if (status === 404) {
    return yield* new ClaudeCloudNotFoundError({ operation });
  }
  if (status === 429) {
    const delay = retryAfterMs(response.headers["retry-after"], yield* Clock.currentTimeMillis);
    return yield* new ClaudeCloudRateLimitedError({
      operation,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  const errorType = yield* readErrorType(response);
  const typed = errorType === undefined ? {} : { errorType };
  return yield* status === 409
    ? new ClaudeCloudConflictError({ operation, ...typed })
    : new ClaudeCloudHttpError({ operation, status, ...typed });
});

export interface ClaudeCloudApiOptions {
  /** Read before every request, so a token the CLI refreshed is picked up. */
  readonly login: Effect.Effect<ClaudeCloudLogin, ClaudeCloudCredentialsError>;
  /** T3 Code's version, sent as `User-Agent: t3code/<version>`. */
  readonly version: string;
  /** Defaults to `https://api.anthropic.com`. */
  readonly baseUrl?: string | undefined;
}

export const make = Effect.fn("ClaudeCloudApi.make")(function* (options: ClaudeCloudApiOptions) {
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const userAgent = `t3code/${options.version}`;

  const execute = Effect.fn("ClaudeCloudApi.execute")(function* (
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const login = yield* options.login;
    const response = yield* httpClient
      .execute(request.pipe(HttpClientRequest.setHeaders(requestHeaders(login, userAgent))))
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) => new ClaudeCloudHttpError({ operation, cause })),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* failForStatus(operation, response);
    }
    return response;
  });

  const requestJson = <S extends Schema.Top>(
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) =>
    execute(operation, request).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) =>
            cause._tag === "HttpClientError" && cause.reason._tag === "DecodeError"
              ? new ClaudeCloudDecodeError({ operation, cause })
              : new ClaudeCloudHttpError({ operation, cause }),
          ),
        ),
      ),
      Effect.flatMap((json) =>
        Schema.decodeEffect(schema)(json).pipe(
          Effect.mapError((cause) => new ClaudeCloudDecodeError({ operation, cause })),
        ),
      ),
    );

  const sessionFrom = (operation: Operation, envelope: typeof SessionEnvelope.Type) => {
    const record = envelope.session ?? envelope.response_shape;
    return record === undefined
      ? Effect.fail(
          new ClaudeCloudDecodeError({
            operation,
            cause: new Error("The response had no session."),
          }),
        )
      : Effect.succeed(sessionFromRecord(record));
  };

  const listEnvironments = Effect.gen(function* () {
    const environments: Array<ClaudeCloudEnvironment> = [];
    let afterId: string | undefined;
    for (let page = 0; page < MAX_ENVIRONMENT_PAGES; page += 1) {
      const body = yield* requestJson(
        "listEnvironments",
        HttpClientRequest.get(`${baseUrl}/v1/environment_providers`, {
          urlParams: {
            limit: String(ENVIRONMENT_PAGE_SIZE),
            ...(afterId === undefined ? {} : { after_id: afterId }),
          },
        }),
        EnvironmentPage,
      );
      for (const raw of body.environments) {
        const record = decodeEnvironmentRecord(raw);
        if (Option.isNone(record)) continue;
        environments.push({ id: record.value.environment_id, kind: record.value.kind });
      }
      if (!body.has_more || !body.last_id || body.last_id === afterId) break;
      afterId = body.last_id;
    }
    return environments;
  }).pipe(Effect.withSpan("ClaudeCloudApi.listEnvironments"));

  const createSession = Effect.fn("ClaudeCloudApi.createSession")(function* (
    input: ClaudeCloudCreateSessionInput,
  ) {
    const events =
      input.permissionMode === undefined
        ? []
        : [
            {
              payload: {
                type: "control_request",
                request_id: `set-mode-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
                request: { subtype: "set_permission_mode", mode: input.permissionMode },
              },
            },
          ];
    const body = {
      title: input.title,
      ...(input.environmentId.startsWith("ccpool_")
        ? { self_hosted_runner_pool_id: input.environmentId }
        : { environment_id: input.environmentId }),
      events,
      config: {
        sources: [
          {
            type: "git_repository",
            url: input.source.repoUrl,
            ...(input.source.revision === null ? {} : { revision: input.source.revision }),
          },
        ],
        ...(input.outcomeBranch === undefined
          ? {}
          : {
              outcomes: [
                {
                  type: "git_repository",
                  git_info: {
                    type: "github",
                    repo: githubRepository(input.source.repoUrl),
                    branches: [input.outcomeBranch],
                  },
                },
              ],
            }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effortLevel === undefined ? {} : { effort_level: input.effortLevel }),
      },
    };
    const envelope = yield* requestJson(
      "createSession",
      HttpClientRequest.post(`${baseUrl}/v1/code/sessions`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      SessionEnvelope,
    );
    return yield* sessionFrom("createSession", envelope);
  });

  const getSession = Effect.fn("ClaudeCloudApi.getSession")(function* (sessionId: string) {
    const envelope = yield* requestJson(
      "getSession",
      HttpClientRequest.get(`${baseUrl}${sessionPath(sessionId)}`),
      SessionEnvelope,
    );
    return yield* sessionFrom("getSession", envelope);
  });

  const latestSequenceNum = Effect.fn("ClaudeCloudApi.latestSequenceNum")(function* (
    sessionId: string,
  ) {
    const page = yield* requestJson(
      "listEvents",
      HttpClientRequest.get(`${baseUrl}${sessionPath(sessionId)}/events`, {
        urlParams: { sort_order: "desc", limit: "1" },
      }),
      EventPage,
    );
    const latest = page.data[0];
    if (latest === undefined) return 0;
    const sequenceNum = Number(latest.sequence_num);
    if (!Number.isSafeInteger(sequenceNum) || sequenceNum < 0) {
      return yield* new ClaudeCloudDecodeError({
        operation: "listEvents",
        cause: new Error("The event's sequence number is not a non-negative integer."),
      });
    }
    return sequenceNum;
  });

  // Served from the user's file store rather than the session, so it works after the
  // session's container is gone.
  const downloadFile = Effect.fn("ClaudeCloudApi.downloadFile")(function* (fileUuid: string) {
    const response = yield* execute(
      "downloadFile",
      HttpClientRequest.get(`${baseUrl}/api/oauth/files/${encodeURIComponent(fileUuid)}/content`),
    );
    const sizeBytes = Number(response.headers["content-length"]);
    return {
      sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : undefined,
      stream: response.stream.pipe(
        Stream.mapError((cause) => new ClaudeCloudHttpError({ operation: "downloadFile", cause })),
      ),
    } satisfies ClaudeCloudFileContent;
  });

  const sessionTransport = Effect.fn("ClaudeCloudApi.sessionTransport")(function* (
    sessionId: string,
  ) {
    const login = yield* options.login;
    return {
      sessionId: toCse(sessionId),
      ...sessionUrls(baseUrl, sessionId),
      headers: requestHeaders(login, userAgent),
      expiresAt: login.expiresAt,
    } satisfies ClaudeCloudSessionTransport;
  });

  return {
    listEnvironments,
    createSession,
    getSession,
    latestSequenceNum,
    downloadFile,
    sessionTransport,
  } satisfies ClaudeCloudApi;
});
