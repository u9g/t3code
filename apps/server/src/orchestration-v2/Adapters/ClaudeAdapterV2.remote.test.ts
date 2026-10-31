// Claude Code cloud sessions run the adapter over the remote transport. These tests live
// apart from ClaudeAdapterV2.test.ts so the patch adding them stays out of upstream's file.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  ChatUnknownAttachment,
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 remote transport", () => {
  const CLAUDE_CLOUD_DRIVER = ProviderDriverKind.make("claudeCloud");
  const REMOTE_CAPABILITIES = {
    ...ClaudeAdapterV2.ClaudeProviderCapabilitiesV2,
    threads: { ...ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.threads, canRollbackThread: false },
  };

  const makeRemoteAdapter = Effect.fnUntraced(function* (
    prefix: string,
    options?: {
      readonly transport?: ClaudeAdapterV2.ClaudeAdapterV2Transport;
      readonly checkResumable?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["checkResumable"];
      readonly messages?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["messages"];
    },
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const allocations: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionAllocateInput> = [];
    const offeredMessages: Array<SDKUserMessage> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ProviderInstanceId.make("claude-cloud"),
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      driverKind: CLAUDE_CLOUD_DRIVER,
      capabilities: REMOTE_CAPABILITIES,
      transport: options?.transport ?? "remote",
      queryRunner: {
        ...(options?.checkResumable === undefined
          ? {}
          : { checkResumable: options.checkResumable }),
        allocateSessionId: Effect.die("A remote session is created for its thread."),
        allocateSessionIdFor: (input) =>
          Effect.sync(() => {
            allocations.push(input);
            return allocations.length === 1 ? "cse_remote" : `cse_remote_${allocations.length}`;
          }),
        open: () =>
          Effect.succeed({
            messages: options?.messages ?? Stream.never,
            offer: (message) =>
              Effect.sync(() => {
                offeredMessages.push(message);
              }),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-${prefix}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${prefix}`),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    return { adapter, runtime, threadId, attachmentsDir, allocations, offeredMessages };
  });

  it.effect(
    "stamps the hosting driver and its capabilities on the session, thread and events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const remote = yield* makeRemoteAdapter("claude-remote-identity");
          assert.equal(remote.adapter.driver, CLAUDE_CLOUD_DRIVER);
          assert.deepEqual(yield* remote.adapter.getCapabilities(), REMOTE_CAPABILITIES);
          assert.equal(remote.runtime.driver, CLAUDE_CLOUD_DRIVER);
          assert.equal(remote.runtime.providerSession.driver, CLAUDE_CLOUD_DRIVER);
          assert.deepEqual(remote.runtime.providerSession.capabilities, REMOTE_CAPABILITIES);
          assert.isUndefined(remote.runtime.backgroundTasksEndWithProcess);

          const ensureInput = {
            threadId: remote.threadId,
            title: "Fix the flaky test",
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          };
          const providerThread = yield* remote.runtime.ensureThread(ensureInput);
          assert.deepEqual(remote.allocations, [ensureInput]);
          assert.equal(providerThread.driver, CLAUDE_CLOUD_DRIVER);
          assert.deepEqual(providerThread.nativeThreadRef, {
            driver: CLAUDE_CLOUD_DRIVER,
            nativeId: "cse_remote",
            strength: "strong",
          });

          yield* remote.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: remote.threadId,
              providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-remote-identity"),
              text: "Hello",
              attachments: [],
            }),
          );
          const event = yield* remote.runtime.events.pipe(Stream.runHead);
          assert.isTrue(Option.isSome(event));
          if (Option.isNone(event)) return;
          assert.equal(event.value.driver, CLAUDE_CLOUD_DRIVER);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["local", "remote"] as const)(
    "asks a %s runner whether the session can still take turns before resuming it",
    (transport) =>
      Effect.scoped(
        Effect.gen(function* () {
          const checked: Array<string> = [];
          const remote = yield* makeRemoteAdapter(`claude-remote-resume-${transport}`, {
            transport,
            checkResumable: (nativeThreadId) =>
              Effect.sync(() => {
                checked.push(nativeThreadId);
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "checkResumable",
                      cause: "archived",
                      reason: "session_archived",
                    }),
                  ),
                ),
              ),
          });
          const ensureInput = {
            threadId: remote.threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          };
          const providerThread = yield* remote.runtime.ensureThread(ensureInput);
          const resumed = yield* remote.runtime.resumeThread({ providerThread }).pipe(Effect.exit);
          if (transport === "local") {
            assert.isTrue(Exit.isSuccess(resumed));
            assert.deepEqual(checked, []);
            return;
          }
          assert.deepEqual(checked, ["cse_remote"]);
          assert.isTrue(Exit.isFailure(resumed));
          // What turn start does after a failed resume: bind a new session.
          const replacement = yield* remote.runtime.ensureThread({
            ...ensureInput,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          });
          assert.equal(replacement.nativeThreadRef?.nativeId, "cse_remote_2");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("fails the running turn with the reason a cloud session could not start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startFailed = yield* Deferred.make<
          never,
          ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError
        >();
        const remote = yield* makeRemoteAdapter("claude-remote-start-failure", {
          messages: Stream.fromEffect(Deferred.await(startFailed)),
        });
        const providerThread = yield* remote.runtime.ensureThread({
          threadId: remote.threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* remote.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: remote.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-remote-start-failure"),
            text: "Hello",
            attachments: [],
          }),
        );
        assert.lengthOf(remote.offeredMessages, 1);

        yield* Deferred.fail(
          startFailed,
          new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
            method: "getSession",
            cause: "The cloud session's worker failed to start (ref_not_found).",
            reason: "branch_not_found",
          }),
        );
        const terminal = yield* remote.runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        assert.isTrue(Option.isSome(terminal));
        if (Option.isNone(terminal) || terminal.value.type !== "turn.terminal") return;
        assert.equal(terminal.value.status, "failed");
        if (terminal.value.status !== "failed") return;
        assert.equal(
          terminal.value.failure.message,
          "The Claude Code cloud session couldn't check out the branch from GitHub, so it never started. Check that the branch is pushed and still exists on GitHub, then start a new thread.",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("inlines text files instead of local paths and keeps images as base64", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const remote = yield* makeRemoteAdapter("claude-remote-attachments");
        const providerThread = yield* remote.runtime.ensureThread({
          threadId: remote.threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const attachmentId = (suffix: string) =>
          ChatAttachmentId.make(`thread-claude-remote-${suffix}-1234-1234-1234-123456789abc`);
        const image = ChatImageAttachment.make({
          type: "image",
          id: attachmentId("12345678"),
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const notesText = "# Notes\nhello é";
        const notes = ChatFileAttachment.make({
          type: "file",
          id: attachmentId("abcdefab"),
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: new TextEncoder().encode(notesText).length,
        });
        const binary = ChatFileAttachment.make({
          type: "file",
          id: attachmentId("bcdefabc"),
          name: "blob.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 3,
        });
        const huge = ChatFileAttachment.make({
          type: "file",
          id: attachmentId("cdefabcd"),
          name: "huge.log",
          mimeType: "text/plain",
          sizeBytes: 300 * 1024,
        });
        for (const [attachment, bytes] of [
          [image, Uint8Array.from([1, 2, 3, 4])],
          [notes, new TextEncoder().encode(notesText)],
          [binary, Uint8Array.from([0xff, 0x00, 0x01])],
          [huge, new TextEncoder().encode("too big")],
        ] as const) {
          yield* fileSystem.writeFile(
            path.join(remote.attachmentsDir, attachmentRelativePath(attachment)!),
            bytes,
          );
        }

        yield* remote.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: remote.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-remote-attachments"),
            text: "Summarize these.",
            attachments: [image, notes, binary, huge],
          }),
        );

        assert.deepEqual(remote.offeredMessages[0]?.message.content, [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AQIDBA==" },
          },
          {
            type: "text",
            text: `[Attached file "notes.md" (text/markdown) follows]\n${notesText}\n[End of attached file "notes.md"]`,
          },
          {
            type: "text",
            text: `[Attached file "blob.bin" was not sent: remote sessions only receive UTF-8 text files.]`,
          },
          {
            type: "text",
            text: `[Attached file "huge.log" was not sent: remote sessions receive at most 256 KiB of attached text per message.]`,
          },
          { type: "text", text: "Ultrathink:\nSummarize these." },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("names attachments the session does not receive and keeps window context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const remote = yield* makeRemoteAdapter("claude-remote-attachment-budget");
        const providerThread = yield* remote.runtime.ensureThread({
          threadId: remote.threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const image = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make("thread-claude-remote-deadbeef-1234-1234-1234-123456789abc"),
          name: "window.png",
          mimeType: "image/png",
          sizeBytes: 4,
          source: {
            kind: "snap-shot",
            capturedAt: "2026-08-24T11:00:00.000Z",
            appName: "Editor",
            windowTitle: "main.ts",
            accessibleText: "Visible excerpt",
          },
        });
        yield* fileSystem.writeFile(
          path.join(remote.attachmentsDir, attachmentRelativePath(image)!),
          Uint8Array.from([1, 2, 3, 4]),
        );
        const audio = ChatUnknownAttachment.make({
          type: "audio",
          id: ChatAttachmentId.make("thread-claude-remote-feedface-1234-1234-1234-123456789abc"),
          name: "memo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 3,
        });

        yield* remote.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: remote.threadId,
            providerThread: {
              ...providerThread,
              nativeMetadata: {
                ...providerThread.nativeMetadata,
                claudeAttachmentBudget: { bytesUsed: 28 * 1024 * 1024, pagesUsed: 0 },
              },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-remote-attachment-budget"),
            text: "What is open?",
            attachments: [image, audio],
          }),
        );

        const content = remote.offeredMessages[0]?.message.content;
        const [imageNotice, audioNotice, prompt, ...rest] = Array.isArray(content) ? content : [];
        assert.deepEqual(imageNotice, {
          type: "text",
          text: `[Attached image "window.png" was not sent: it would take this conversation's attachments past Claude's request size limit.]`,
        });
        assert.deepEqual(audioNotice, {
          type: "text",
          text: `[Attached audio "memo.m4a" was not sent: remote sessions cannot receive this attachment type.]`,
        });
        const promptText = prompt?.type === "text" ? prompt.text : "";
        assert.include(promptText, "Visible excerpt");
        assert.notInclude(promptText, "window.png");
        assert.notInclude(promptText, "memo.m4a");
        assert.deepEqual(rest, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
