import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { claudeCloudSecretsServer } from "./ClaudeCloudSecrets.ts";

const connect = async () => {
  let reads = 0;
  const { instance } = claudeCloudSecretsServer({
    GITHUB_TOKEN: Effect.sync(() => `ghp_${++reads}`),
    EMPTY: Effect.succeed(null),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [part] = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(part!.text) as unknown;
  };
  return { client, call };
};

describe("claudeCloudSecretsServer", () => {
  it("lists the secrets by name", async () => {
    const { client, call } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [
      "get_secret",
      "list_secret_names",
    ]);
    assert.deepEqual(await call("list_secret_names"), ["GITHUB_TOKEN", "EMPTY"]);
  });

  it("reads a secret on each call, and answers null for one it lacks or that has no value", async () => {
    const { call } = await connect();
    assert.equal(await call("get_secret", { name: "GITHUB_TOKEN" }), "ghp_1");
    assert.equal(await call("get_secret", { name: "GITHUB_TOKEN" }), "ghp_2");
    assert.isNull(await call("get_secret", { name: "EMPTY" }));
    assert.isNull(await call("get_secret", { name: "toString" }));
    assert.isNull(await call("get_secret", { name: "MISSING" }));
  });
});
