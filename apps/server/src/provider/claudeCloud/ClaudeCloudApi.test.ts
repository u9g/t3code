import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";

import * as ClaudeCloudApi from "./ClaudeCloudApi.ts";
import { ClaudeCloudCredentialsError, type ClaudeCloudLogin } from "./ClaudeCloudCredentials.ts";

const TOKEN = "sk-ant-oat-test-token";
const BASE = "https://cloud.test";

const login: ClaudeCloudLogin = {
  accessToken: Redacted.make(TOKEN),
  expiresAt: null,
  scopes: ["user:sessions:claude_code"],
  subscriptionType: "max",
  organizationUuid: "org-1",
};

const sessionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "cse_01Abc",
  status: "active",
  worker_status: "idle",
  connection_status: "disconnected",
  environment_id: "env_1",
  session_url: "https://claude.ai/code/cshk_01AbcXyz",
  title: "Fix the bug",
  config: { model: "claude-opus-5-5", origin: "t3code", sources: [] },
  tags: ["config:auto-create-pr:off"],
  client_presence: [],
  ...overrides,
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly urlParams: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

/** Answers each request from `respond` and records what was sent. */
const fakeServer = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | "network-error",
) => {
  const requests: Array<Recorded> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      urlParams: UrlParams.toString(request.urlParams),
      headers: request.headers,
      body: bodyOf(request),
    });
    const response = respond(request);
    return response === "network-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { client, requests };
};

const makeApi = (
  client: HttpClient.HttpClient,
  options: Partial<ClaudeCloudApi.ClaudeCloudApiOptions> = {},
) =>
  ClaudeCloudApi.make({
    login: Effect.succeed(login),
    version: "1.2.3",
    baseUrl: `${BASE}/`,
    ...options,
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));

it.layer(NodeServices.layer)("ClaudeCloudApi", (it) => {
  describe("session ids", () => {
    it("converts between the cse_ and session_ forms", () => {
      expect(ClaudeCloudApi.toCse("session_01Abc")).toBe("cse_01Abc");
      expect(ClaudeCloudApi.toCse("cse_01Abc")).toBe("cse_01Abc");
      expect(ClaudeCloudApi.toSession("cse_01Abc")).toBe("session_01Abc");
      expect(ClaudeCloudApi.toSession("session_01Abc")).toBe("session_01Abc");
      expect(ClaudeCloudApi.claudeCloudWebUrl("cse_01Abc")).toBe(
        "https://claude.ai/code/session_01Abc",
      );
      expect(ClaudeCloudApi.sessionUrls(BASE, "session_01Abc")).toEqual({
        streamUrl: `${BASE}/v1/code/sessions/cse_01Abc/events/stream`,
        sendUrl: `${BASE}/v1/code/sessions/cse_01Abc/events`,
      });
    });
  });

  describe("requests", () => {
    it.effect("sends the cloud headers, with the organization when known", () =>
      Effect.gen(function* () {
        const server = fakeServer(() => Response.json({ environments: [] }));
        yield* (yield* makeApi(server.client)).listEnvironments;
        yield* (yield* makeApi(server.client, {
          login: Effect.succeed({ ...login, organizationUuid: null }),
        })).listEnvironments;
        expect(server.requests[0]?.headers).toMatchObject({
          authorization: `Bearer ${TOKEN}`,
          "anthropic-version": "2023-06-01",
          "anthropic-client-platform": "claude_code_cli",
          "user-agent": "t3code/1.2.3",
          "x-organization-uuid": "org-1",
        });
        expect(server.requests[1]?.headers).not.toHaveProperty("x-organization-uuid");
      }),
    );

    it.effect("pages through environments and skips entries it cannot read", () =>
      Effect.gen(function* () {
        const server = fakeServer((request) =>
          UrlParams.toString(request.urlParams).includes("after_id")
            ? Response.json({
                environments: [{ environment_id: "env_3", kind: "bridge", name: "Laptop" }],
                has_more: false,
              })
            : Response.json({
                environments: [
                  {
                    environment_id: "env_1",
                    kind: "anthropic_cloud",
                    name: "wishblock",
                    state: "active",
                    config: null,
                  },
                  { kind: "anthropic_cloud" },
                  { environment_id: "env_2", kind: "future_kind", name: null },
                ],
                has_more: true,
                first_id: "env_1",
                last_id: "env_2",
              }),
        );
        const environments = yield* (yield* makeApi(server.client)).listEnvironments;
        expect(environments).toEqual([
          { id: "env_1", kind: "anthropic_cloud" },
          { id: "env_2", kind: "future_kind" },
          { id: "env_3", kind: "bridge" },
        ]);
        expect(server.requests.map((request) => [request.url, request.urlParams])).toEqual([
          [`${BASE}/v1/environment_providers`, "limit=100"],
          [`${BASE}/v1/environment_providers`, "limit=100&after_id=env_2"],
        ]);
      }),
    );

    it.effect("creates a session from the repository source and permission mode", () =>
      Effect.gen(function* () {
        const server = fakeServer(() =>
          Response.json({ deduplicated: false, session: sessionRecord(), unknown_field: 1 }),
        );
        const api = yield* makeApi(server.client);
        const session = yield* api.createSession({
          title: "Fix the bug",
          environmentId: "env_1",
          source: { repoUrl: "https://github.com/octo-org/octo-repo", revision: "feat/x" },
          model: "claude-opus-5-5",
          effortLevel: "high",
          permissionMode: "plan",
          outcomeBranch: "claude/fix-the-bug",
        });
        expect(session).toEqual({
          id: "cse_01Abc",
          status: "active",
          webUrl: "https://claude.ai/code/session_01Abc",
          connectionStatus: "disconnected",
          workerStatus: "idle",
          environmentKind: null,
          lastInitError: null,
        });
        const request = server.requests[0];
        expect([request?.method, request?.url]).toEqual(["POST", `${BASE}/v1/code/sessions`]);
        expect(request?.body).toEqual({
          title: "Fix the bug",
          environment_id: "env_1",
          events: [
            {
              payload: {
                type: "control_request",
                request_id: expect.stringMatching(/^set-mode-[0-9a-f-]{36}$/),
                request: { subtype: "set_permission_mode", mode: "plan" },
              },
            },
          ],
          config: {
            sources: [
              {
                type: "git_repository",
                url: "https://github.com/octo-org/octo-repo",
                revision: "feat/x",
              },
            ],
            outcomes: [
              {
                type: "git_repository",
                git_info: {
                  type: "github",
                  repo: "octo-org/octo-repo",
                  branches: ["claude/fix-the-bug"],
                },
              },
            ],
            model: "claude-opus-5-5",
            effort_level: "high",
          },
        });
      }),
    );

    it.effect("sends self-hosted pools as such and omits what was not given", () =>
      Effect.gen(function* () {
        const server = fakeServer(() =>
          Response.json({ deduplicated: true, session: sessionRecord({ session_url: null }) }),
        );
        const session = yield* (yield* makeApi(server.client)).createSession({
          title: "t",
          environmentId: "ccpool_01",
          source: { repoUrl: "https://github.com/o/r", revision: null },
        });
        expect(session.id).toBe("cse_01Abc");
        expect(server.requests[0]?.body).toEqual({
          title: "t",
          self_hosted_runner_pool_id: "ccpool_01",
          events: [],
          config: { sources: [{ type: "git_repository", url: "https://github.com/o/r" }] },
        });
      }),
    );

    it.effect("reads a session's status and its latest sequence number", () =>
      Effect.gen(function* () {
        let events: ReadonlyArray<unknown> = [{ sequence_num: "57", event_type: "result" }];
        const server = fakeServer((request) =>
          request.url.endsWith("/events")
            ? Response.json({ data: events })
            : Response.json({
                response_shape: sessionRecord({ id: "session_01Abc", status: "archived" }),
              }),
        );
        const api = yield* makeApi(server.client);
        expect(yield* api.getSession("session_01Abc")).toEqual({
          id: "cse_01Abc",
          status: "archived",
          webUrl: "https://claude.ai/code/session_01Abc",
          connectionStatus: "disconnected",
          workerStatus: "idle",
          environmentKind: null,
          lastInitError: null,
        });
        expect(yield* api.latestSequenceNum("cse_01Abc")).toBe(57);
        events = [];
        expect(yield* api.latestSequenceNum("cse_01Abc")).toBe(0);
        expect(
          server.requests.map((request) => [request.method, request.url, request.urlParams]),
        ).toEqual([
          ["GET", `${BASE}/v1/code/sessions/cse_01Abc`, ""],
          ["GET", `${BASE}/v1/code/sessions/cse_01Abc/events`, "sort_order=desc&limit=1"],
          ["GET", `${BASE}/v1/code/sessions/cse_01Abc/events`, "sort_order=desc&limit=1"],
        ]);
      }),
    );

    it.effect("reads why a session's worker failed to start, without its message", () =>
      Effect.gen(function* () {
        let metadata: unknown = {
          permission_mode: "default",
          last_init_error: {
            at: "2026-10-18T23:44:32Z",
            error_kind: "source_processing",
            error_type: "ref_not_found",
            message: 'The requested branch or commit was not found in the repository "o/private".',
            recoverable: "false",
            source_type: "git_repository",
          },
        };
        const server = fakeServer(() =>
          Response.json({
            response_shape: sessionRecord({
              environment_kind: "anthropic_cloud",
              worker_status: "WORKER_STATUS_UNSPECIFIED",
              external_metadata: metadata,
            }),
          }),
        );
        const api = yield* makeApi(server.client);
        const failed = yield* api.getSession("cse_01Abc");
        expect(failed).toMatchObject({
          connectionStatus: "disconnected",
          workerStatus: "WORKER_STATUS_UNSPECIFIED",
          environmentKind: "anthropic_cloud",
          lastInitError: {
            kind: "source_processing",
            type: "ref_not_found",
            recoverable: false,
            at: Date.parse("2026-10-18T23:44:32Z"),
          },
        });
        expect(JSON.stringify(failed)).not.toContain("o/private");

        metadata = { last_init_error: { error_type: "Not An Identifier", recoverable: true } };
        expect((yield* api.getSession("cse_01Abc")).lastInitError).toEqual({
          kind: null,
          type: null,
          recoverable: true,
          at: null,
        });
        // A shape the client does not expect leaves the rest of the session readable.
        for (const unexpected of ["oops", { last_init_error: "oops" }, null]) {
          metadata = unexpected;
          expect(yield* api.getSession("cse_01Abc")).toMatchObject({
            status: "active",
            lastInitError: null,
          });
        }
      }),
    );

    it.effect("builds the SDK transport from a freshly read login", () =>
      Effect.gen(function* () {
        let reads = 0;
        const api = yield* makeApi(fakeServer(() => Response.json({})).client, {
          login: Effect.sync(() => {
            reads += 1;
            return { ...login, expiresAt: 1_800_000 };
          }),
        });
        const transport = yield* api.sessionTransport("session_01Abc");
        yield* api.sessionTransport("session_01Abc");
        expect(reads).toBe(2);
        expect(transport).toEqual({
          sessionId: "cse_01Abc",
          streamUrl: `${BASE}/v1/code/sessions/cse_01Abc/events/stream`,
          sendUrl: `${BASE}/v1/code/sessions/cse_01Abc/events`,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "anthropic-version": "2023-06-01",
            "anthropic-client-platform": "claude_code_cli",
            "user-agent": "t3code/1.2.3",
            "x-organization-uuid": "org-1",
          },
          expiresAt: 1_800_000,
        });
      }),
    );
  });

  describe("downloadFile", () => {
    const FILE_UUID = "d56e0bb8-4d97-4899-9e40-56adcab71b5c";

    it.effect("streams a sent file from the user's file store", () =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode("video bytes");
        const server = fakeServer(
          () =>
            new Response(bytes, {
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(bytes.byteLength),
              },
            }),
        );
        const content = yield* (yield* makeApi(server.client)).downloadFile(FILE_UUID);
        const chunks = yield* Stream.runCollect(content.stream);

        expect(content.sizeBytes).toBe(bytes.byteLength);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
        expect(server.requests).toMatchObject([
          {
            method: "GET",
            url: `${BASE}/api/oauth/files/${FILE_UUID}/content`,
            headers: { authorization: `Bearer ${TOKEN}`, "x-organization-uuid": "org-1" },
          },
        ]);
      }),
    );

    it.effect("reports a missing file as the file, not the session", () =>
      Effect.gen(function* () {
        const api = yield* makeApi(fakeServer(() => Response.json({}, { status: 404 })).client);
        const error = yield* api.downloadFile(FILE_UUID).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ClaudeCloudNotFoundError",
          operation: "downloadFile",
        });
        expect(error.message).toBe("Claude Cloud could not find the file the cloud session sent.");
      }),
    );
  });

  describe("errors", () => {
    const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.result,
        Effect.map((result) => (Result.isFailure(result) ? result.failure : undefined)),
      );

    it.effect("maps statuses to typed errors", () =>
      Effect.gen(function* () {
        const statusError = (response: Response) =>
          Effect.gen(function* () {
            const api = yield* makeApi(fakeServer(() => response.clone()).client);
            return yield* failureOf(api.getSession("cse_01Abc"));
          });
        expect(yield* statusError(Response.json({}, { status: 401 }))).toMatchObject({
          _tag: "ClaudeCloudUnauthorizedError",
          status: 401,
        });
        expect(yield* statusError(Response.json({}, { status: 403 }))).toMatchObject({
          _tag: "ClaudeCloudUnauthorizedError",
          status: 403,
        });
        expect(
          yield* statusError(
            Response.json({ error: { type: "not_found_error" } }, { status: 404 }),
          ),
        ).toMatchObject({ _tag: "ClaudeCloudNotFoundError", operation: "getSession" });
        expect(
          yield* statusError(
            Response.json(
              { error: { type: "session_not_active", message: "Session cse_01Abc is not active" } },
              { status: 409 },
            ),
          ),
        ).toMatchObject({ _tag: "ClaudeCloudConflictError", errorType: "session_not_active" });
        expect(
          yield* statusError(Response.json({}, { status: 429, headers: { "retry-after": "7" } })),
        ).toMatchObject({ _tag: "ClaudeCloudRateLimitedError", retryAfterMs: 7000 });
        const serverError = yield* statusError(
          Response.json(
            { error: { type: "api_error", message: "secret detail" } },
            { status: 500 },
          ),
        );
        expect(serverError).toMatchObject({
          _tag: "ClaudeCloudHttpError",
          status: 500,
          errorType: "api_error",
        });
        expect(serverError?.message).toBe(
          "Claude Cloud failed while reading the cloud session (HTTP 500).",
        );
        expect(yield* statusError(new Response("{not json", { status: 200 }))).toMatchObject({
          _tag: "ClaudeCloudDecodeError",
          operation: "getSession",
        });
        expect(yield* statusError(Response.json({ unexpected: true }))).toMatchObject({
          _tag: "ClaudeCloudDecodeError",
          operation: "getSession",
        });
      }),
    );

    it.effect("reports network failures without a status", () =>
      Effect.gen(function* () {
        const api = yield* makeApi(fakeServer(() => "network-error").client);
        const failure = yield* failureOf(api.listEnvironments);
        expect(failure).toMatchObject({
          _tag: "ClaudeCloudHttpError",
          operation: "listEnvironments",
        });
        expect(failure).not.toHaveProperty("status");
      }),
    );

    it.effect("fails with the login error before sending anything", () =>
      Effect.gen(function* () {
        const server = fakeServer(() => Response.json({}));
        const api = yield* makeApi(server.client, {
          login: Effect.fail(new ClaudeCloudCredentialsError({ reason: "expired", store: "file" })),
        });
        expect(yield* failureOf(api.getSession("cse_01Abc"))).toMatchObject({
          _tag: "ClaudeCloudCredentialsError",
          reason: "expired",
        });
        expect(server.requests).toEqual([]);
      }),
    );
  });
});
