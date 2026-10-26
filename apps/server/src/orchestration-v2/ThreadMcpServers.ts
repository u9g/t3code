import {
  ProviderDriverKind,
  ThreadId,
  ThreadMcpServers as ThreadMcpServersSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class ThreadMcpServersError extends Schema.TaggedError<ThreadMcpServersError>()(
  "ThreadMcpServersError",
  {
    operation: Schema.Literals(["save", "read", "remove"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the MCP servers of thread ${this.threadId}.`;
  }
}

const DRIVERS_TAKING_THREAD_MCP_SERVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "claudeCloud",
]);

/** Whether this driver's adapter hands a thread's MCP servers to its agent. */
export const driverTakesThreadMcpServers = (driver: ProviderDriverKind) =>
  DRIVERS_TAKING_THREAD_MCP_SERVERS.has(driver);

export const unsupportedThreadMcpServersMessage = (driver: ProviderDriverKind) =>
  `This thread has MCP servers of its own, which ${driver} cannot use. Run it on Claude or Claude Cloud.`;

/** A turn that would run without the thread's MCP servers; its message reaches the thread. */
export class ThreadMcpServersUnsupportedError extends Schema.TaggedError<ThreadMcpServersUnsupportedError>()(
  "ThreadMcpServersUnsupportedError",
  { driver: ProviderDriverKind },
) {
  override get message(): string {
    return unsupportedThreadMcpServersMessage(this.driver);
  }
}

/**
 * The MCP servers a thread was started with. They live in the secret store,
 * not in the thread's events, because their headers hold credentials and
 * thread events reach every client.
 */
export class ThreadMcpServers extends Context.Reference<{
  readonly save: (
    threadId: ThreadId,
    servers: ThreadMcpServersSchema,
  ) => Effect.Effect<void, ThreadMcpServersError>;
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadMcpServersSchema | undefined, ThreadMcpServersError>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void, ThreadMcpServersError>;
}>("t3/orchestration-v2/ThreadMcpServers", {
  defaultValue: () => ({
    save: (threadId) =>
      Effect.fail(
        new ThreadMcpServersError({
          operation: "save",
          threadId,
          cause: "No store for thread MCP servers.",
        }),
      ),
    read: () => Effect.succeed(undefined),
    remove: () => Effect.void,
  }),
}) {}

const ThreadMcpServersJson = Schema.fromJsonString(ThreadMcpServersSchema);
const encodeServers = Schema.encodeEffect(ThreadMcpServersJson);
const decodeServers = Schema.decodeUnknownEffect(ThreadMcpServersJson);

// Thread ids may hold characters a file name cannot.
const secretName = (threadId: ThreadId) =>
  `thread-mcp-servers-${Buffer.from(threadId, "utf8").toString("base64url")}`;

export const layer = Layer.effect(
  ThreadMcpServers,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const fail =
      (operation: ThreadMcpServersError["operation"], threadId: ThreadId) => (cause: unknown) =>
        new ThreadMcpServersError({ operation, threadId, cause });
    return {
      save: Effect.fn("ThreadMcpServers.save")(function* (threadId, servers) {
        const json = yield* encodeServers(servers).pipe(Effect.mapError(fail("save", threadId)));
        yield* secrets
          .set(secretName(threadId), new TextEncoder().encode(json))
          .pipe(Effect.mapError(fail("save", threadId)));
      }),
      read: Effect.fn("ThreadMcpServers.read")(function* (threadId) {
        const stored = yield* secrets
          .get(secretName(threadId))
          .pipe(Effect.mapError(fail("read", threadId)));
        if (Option.isNone(stored)) return undefined;
        return yield* decodeServers(new TextDecoder().decode(stored.value)).pipe(
          Effect.mapError(fail("read", threadId)),
        );
      }),
      remove: (threadId) =>
        secrets.remove(secretName(threadId)).pipe(Effect.mapError(fail("remove", threadId))),
    };
  }),
);
