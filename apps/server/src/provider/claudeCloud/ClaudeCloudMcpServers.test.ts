// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as Effect from "effect/Effect";

import { relayedClaudeCloudMcpServers } from "./ClaudeCloudMcpServers.ts";

/** An HTTP MCP server whose `whoami` reports the credential it was called with. */
const httpMcpServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = new McpServer({ name: "endpoint", version: "1.0.0" });
    server.registerTool("whoami", { description: "Says who called." }, async (extra) => ({
      content: [{ type: "text", text: String(extra.requestInfo?.headers.authorization) }],
    }));
    const calls = { requestSecret: 0 };
    server.registerTool("request_secret", { description: "Asks for a secret." }, async () => {
      calls.requestSecret += 1;
      return { content: [{ type: "text", text: "secretRef" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => NodeCrypto.randomUUID(),
    });
    // The SDK types its own transport looser than `Transport` under exactOptionalPropertyTypes.
    await server.connect(transport as Parameters<McpServer["connect"]>[0]);
    const http = NodeHttp.createServer((request, response) => {
      void transport.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address() as { readonly port: number };
    return { http, server, calls, url: `http://127.0.0.1:${address.port}/mcp` };
  }),
  ({ http, server }) =>
    Effect.promise(async () => {
      await server.close();
      await new Promise((resolve) => http.close(resolve));
    }),
);

describe("relayedClaudeCloudMcpServers", () => {
  it.live("relays an HTTP server's tools through an in-process server of the same name", () =>
    Effect.gen(function* () {
      const endpoint = yield* httpMcpServer;
      const relayed = yield* relayedClaudeCloudMcpServers({
        "t3-code": {
          type: "http",
          url: endpoint.url,
          headers: { Authorization: "Bearer relay-test" },
          timeout: 60_000,
        },
        local: { type: "stdio", command: "unreachable-from-the-cloud" },
      });
      expect(Object.keys(relayed ?? {})).toEqual(["t3-code"]);
      const server = relayed!["t3-code"]!;
      expect(server).toMatchObject({ type: "sdk", name: "t3-code", timeout: 60_000 });

      // The SDK's side of the session, as the browser query connects it.
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      yield* Effect.promise(() => server.instance.connect(serverSide));
      const client = new Client({ name: "cloud-session", version: "1.0.0" });
      yield* Effect.promise(() => client.connect(clientSide));

      const { tools } = yield* Effect.promise(() => client.listTools());
      expect(tools.map((tool) => tool.name)).toEqual(["whoami", "request_secret"]);
      const result = yield* Effect.promise(() => client.callTool({ name: "whoami" }));
      expect(result.content).toEqual([{ type: "text", text: "Bearer relay-test" }]);

      yield* Effect.promise(() => client.close());
    }).pipe(Effect.scoped),
  );

  it.live("refuses T3's file delivery of a secret, which the cloud shell cannot read", () =>
    Effect.gen(function* () {
      const endpoint = yield* httpMcpServer;
      const relayed = yield* relayedClaudeCloudMcpServers({
        "t3-code": { type: "http", url: endpoint.url },
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      yield* Effect.promise(() => relayed!["t3-code"]!.instance.connect(serverSide));
      const client = new Client({ name: "cloud-session", version: "1.0.0" });
      yield* Effect.promise(() => client.connect(clientSide));

      const refused = yield* Effect.promise(() =>
        client.callTool({ name: "request_secret", arguments: { delivery: "file" } }),
      );
      expect(refused.isError).toBe(true);
      expect(endpoint.calls.requestSecret).toBe(0);

      const asked = yield* Effect.promise(() =>
        client.callTool({ name: "request_secret", arguments: {} }),
      );
      expect(asked.content).toEqual([{ type: "text", text: "secretRef" }]);
      expect(endpoint.calls.requestSecret).toBe(1);

      yield* Effect.promise(() => client.close());
    }).pipe(Effect.scoped),
  );

  it.effect("relays nothing when there is no HTTP server", () =>
    Effect.gen(function* () {
      expect(yield* relayedClaudeCloudMcpServers(undefined)).toBeUndefined();
      expect(
        yield* relayedClaudeCloudMcpServers({ local: { type: "stdio", command: "x" } }),
      ).toBeUndefined();
    }),
  );
});
