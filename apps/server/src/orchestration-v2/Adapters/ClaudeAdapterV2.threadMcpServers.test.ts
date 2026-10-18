// A thread's own MCP servers, as `t3 thread start --mcp-config` gives them, on local
// Claude and on Claude Cloud. Kept apart from ClaudeAdapterV2.test.ts like the remote tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const runtimePolicy = (runtimeMode: "full-access" | "approval-required") =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
  });

const GEM = {
  gem: {
    type: "http" as const,
    url: "http://127.0.0.1:7341/mcp/thread/1",
    headers: { Authorization: "Bearer gem-token" },
  },
};

const mcpSessionFor = (threadId: ThreadId): McpProviderSession.McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make(`environment-${threadId}`),
  threadId,
  providerSessionId: `mcp-session-${threadId}`,
  providerInstanceId: MODEL_SELECTION.instanceId,
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer t3-token",
  browserToolsAvailable: true,
});

const T3_CODE_SERVER = {
  type: "http",
  url: "http://127.0.0.1:43123/mcp",
  headers: { Authorization: "Bearer t3-token" },
  timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
} as const;

describe("claudeMcpQueryOverrides with thread MCP servers", () => {
  const threadId = ThreadId.make("thread-mcp-overrides");

  it("adds them beside t3-code and pre-approves their tools", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: mcpSessionFor(threadId),
        threadMcpServers: GEM,
        readOnlySandbox: false,
        allowedTools: ["Read"],
      }),
      {
        allowedTools: ["Read", ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD, "mcp__gem__*"],
        mcpServers: { ...GEM, "t3-code": T3_CODE_SERVER },
      },
    );
  });

  it("gives them to Claude even without T3 Code's own server", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: undefined,
        threadMcpServers: GEM,
        readOnlySandbox: false,
      }),
      { allowedTools: ["mcp__gem__*"], mcpServers: GEM },
    );
  });

  it("leaves their tools to ask in a read-only sandbox", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: mcpSessionFor(threadId),
      threadMcpServers: GEM,
      readOnlySandbox: true,
    });
    assert.deepEqual(overrides.mcpServers, { ...GEM, "t3-code": T3_CODE_SERVER });
    assert.deepEqual(overrides.allowedTools, ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS);
  });

  it("keeps a live query only while its thread servers stay the same", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      runtimePolicy("approval-required"),
    );
    const key = (threadMcpServers: typeof GEM | undefined) =>
      ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
        queryPolicy,
        ClaudeAdapterV2.claudeMcpQueryOverrides({
          mcpSession: mcpSessionFor(threadId),
          threadMcpServers,
          readOnlySandbox: false,
        }),
      );
    const rotated = {
      gem: { ...GEM.gem, headers: { Authorization: "Bearer rotated-gem-token" } },
    };
    assert.notEqual(key(GEM), key(undefined));
    assert.notEqual(key(GEM), key(rotated));
    assert.equal(key(GEM), key({ gem: { ...GEM.gem } }));
  });

  it("matches pre-approved MCP tools by exact name or server wildcard", () => {
    const allowed = ["Read", "mcp__gem__*", "mcp__t3-code__t3_thread_list"];
    assert.isTrue(ClaudeAdapterV2.claudeMcpToolPreApproved("mcp__gem__propose", allowed));
    assert.isTrue(
      ClaudeAdapterV2.claudeMcpToolPreApproved("mcp__t3-code__t3_thread_list", allowed),
    );
    assert.isFalse(
      ClaudeAdapterV2.claudeMcpToolPreApproved("mcp__t3-code__t3_thread_send", allowed),
    );
    assert.isFalse(ClaudeAdapterV2.claudeMcpToolPreApproved("mcp__gemini__ask", allowed));
    assert.isFalse(ClaudeAdapterV2.claudeMcpToolPreApproved("Read", allowed));
  });
});

function turnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly runtimeMode: "full-access" | "approval-required";
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const attemptId = RunAttemptId.make(`attempt-${input.threadId}`);
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "mcp",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Propose a fix",
    providerInstanceId: MODEL_SELECTION.instanceId,
    modelSelection: MODEL_SELECTION,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId: input.threadId,
    runId: RunId.make(`run-${input.threadId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make(`node-${input.threadId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "mcp",
      messageId: MessageId.make(`message-${input.threadId}`),
      text: "Propose the fix.",
      attachments: [],
    },
    modelSelection: MODEL_SELECTION,
    runtimePolicy: runtimePolicy(input.runtimeMode),
    mcpServers: GEM,
  };
}

describe.each(["local", "remote"] as const)(
  "ClaudeAdapterV2 %s thread MCP servers",
  (transport) => {
    /** Starts one turn of a thread with servers and returns the options its query opened with. */
    const openedQueryOptions = (runtimeMode: "full-access" | "approval-required") =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: MODEL_SELECTION.instanceId,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-mcp-" }),
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          ...(transport === "remote"
            ? { driverKind: ProviderDriverKind.make("claudeCloud"), transport: "remote" as const }
            : {}),
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-mcp"),
            allocateSessionIdFor: () => Effect.succeed("cse_thread_mcp"),
            open: (input) =>
              Effect.sync(() => {
                opened.push(input);
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make(`thread-mcp-${transport}-${runtimeMode}`);
        yield* (yield* McpProviderSessions.McpProviderSessions).set(mcpSessionFor(threadId));
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`provider-session-${threadId}`),
          modelSelection: MODEL_SELECTION,
          runtimePolicy: runtimePolicy(runtimeMode),
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: MODEL_SELECTION,
          runtimePolicy: runtimePolicy(runtimeMode),
        });
        yield* runtime.startTurn(
          turnInput({ threadId, providerThread, now: yield* DateTime.now, runtimeMode }),
        );
        assert.equal(opened.length, 1);
        return opened[0]!.options;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      );

    it.effect("opens the query with the thread's servers pre-approved beside t3-code", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* openedQueryOptions("full-access");
          assert.deepEqual(options.mcpServers, { ...GEM, "t3-code": T3_CODE_SERVER });
          assert.includeMembers([...(options.allowedTools ?? [])], ["mcp__gem__*"]);
        }),
      ),
    );

    if (transport === "remote") {
      // The cloud never sees allowedTools, so an approval-required session asks the
      // adapter about every MCP call; the thread's own tools must not wait on a person.
      it.effect("answers the cloud's prompts for the thread's tools without asking", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const options = yield* openedQueryOptions("approval-required");
            const decision = yield* Effect.promise(() =>
              options.canUseTool!(
                "mcp__gem__propose",
                { summary: "Fix" },
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu_gem_propose",
                  requestId: "request_gem_propose",
                },
              ),
            );
            assert.deepInclude(decision, { behavior: "allow", toolUseID: "toolu_gem_propose" });
          }),
        ),
      );
    }
  },
);
