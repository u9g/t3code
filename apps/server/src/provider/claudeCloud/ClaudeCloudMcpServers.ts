/* oxlint-disable unicorn/prefer-add-event-listener -- MCP transports take handlers only as `on*` properties. */
import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk/browser";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { runMcpHttpRelay } from "../../mcp/AcpMcpStdioBridge.ts";

/**
 * A cloud session cannot reach HTTP MCP servers on this machine, such as T3's
 * own, so each becomes an in-process server of the same name relaying to it;
 * the browser SDK takes no other kind. Every query needs servers of its own.
 */
export const relayedClaudeCloudMcpServers = Effect.fn("relayedClaudeCloudMcpServers")(function* (
  servers: Readonly<Record<string, McpServerConfig>> | undefined,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const relayed: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (server.type !== "http") continue;
    // The SDK only connects its instance to a transport, and the relay passes
    // the endpoint's own `initialize` answer through, so no McpServer is needed.
    // The SDK closes the transport when its query closes, which ends the relay.
    const connect = Effect.fn("relayedClaudeCloudMcpServers.connect")(function* (
      transport: Transport,
    ) {
      const messages = yield* Queue.unbounded<string, Cause.Done>();
      transport.onmessage = (message) => {
        Queue.offerUnsafe(messages, JSON.stringify(message));
      };
      transport.onclose = () => {
        Queue.endUnsafe(messages);
      };
      yield* Effect.promise(() => transport.start());
      yield* Effect.forkDetach(
        runMcpHttpRelay({
          endpoint: server.url,
          authorization: server.headers?.Authorization ?? "",
          messages: Stream.fromQueue(messages),
          // An answer that comes after the query closed has no one to take it.
          deliver: (message) =>
            Effect.tryPromise(() =>
              transport.send(message as Parameters<Transport["send"]>[0]),
            ).pipe(Effect.ignore),
        }),
      );
    });
    const instance = {
      connect: (transport: Transport) => runPromise(connect(transport)),
    } as unknown as McpServer;
    relayed[name] = {
      type: "sdk",
      name,
      instance,
      ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
    };
  }
  return Object.keys(relayed).length === 0 ? undefined : relayed;
});
