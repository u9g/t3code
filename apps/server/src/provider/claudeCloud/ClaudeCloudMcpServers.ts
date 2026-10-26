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

type JsonRpcMessage = Parameters<Transport["send"]>[0];

// T3 writes a file-delivered secret on this machine, where a cloud shell cannot
// read it, so such a call is answered here before the user is asked.
const fileSecretRequestId = (message: JsonRpcMessage) => {
  if (!("method" in message) || !("id" in message) || message.method !== "tools/call") return;
  const params = message.params as
    | { readonly name?: unknown; readonly arguments?: { readonly delivery?: unknown } }
    | undefined;
  return params?.name === "request_secret" && params.arguments?.delivery === "file"
    ? message.id
    : undefined;
};

const FILE_SECRET_REFUSAL = {
  isError: true,
  content: [
    {
      type: "text",
      text: 'delivery "file" saves the secret to a file on the T3 Code machine, which this Claude Code cloud session cannot read. Call request_secret without delivery to get a secretRef for a T3 tool.',
    },
  ],
};

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
    const headers = Object.entries(server.headers ?? {});
    const isAuthorization = ([header]: readonly [string, string]) =>
      header.toLowerCase() === "authorization";
    // The SDK only connects its instance to a transport, and the relay passes
    // the endpoint's own `initialize` answer through, so no McpServer is needed.
    // The SDK closes the transport when its query closes, which ends the relay.
    const connect = Effect.fn("relayedClaudeCloudMcpServers.connect")(function* (
      transport: Transport,
    ) {
      const messages = yield* Queue.unbounded<string, Cause.Done>();
      transport.onmessage = (message) => {
        const refusedId = name === "t3-code" ? fileSecretRequestId(message) : undefined;
        if (refusedId !== undefined) {
          void runPromise(
            Effect.tryPromise(() =>
              transport.send({ jsonrpc: "2.0", id: refusedId, result: FILE_SECRET_REFUSAL }),
            ).pipe(Effect.ignore),
          );
          return;
        }
        Queue.offerUnsafe(messages, JSON.stringify(message));
      };
      transport.onclose = () => {
        Queue.endUnsafe(messages);
      };
      yield* Effect.promise(() => transport.start());
      yield* Effect.forkDetach(
        runMcpHttpRelay({
          endpoint: server.url,
          authorization: headers.find(isAuthorization)?.[1] ?? "",
          headers: Object.fromEntries(headers.filter((header) => !isAuthorization(header))),
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
