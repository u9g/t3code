import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadMcpServers from "./ThreadMcpServers.ts";

const layerStore = () =>
  ThreadMcpServers.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-mcp-servers-" })),
  );

const gem = {
  gem: {
    type: "http" as const,
    url: "http://127.0.0.1:7341/mcp",
    headers: { Authorization: "Bearer gem-token" },
  },
};

it.layer(NodeServices.layer)("ThreadMcpServers.layer", (it) => {
  it.effect("keeps a thread's servers until the thread's cleanup removes them", () =>
    Effect.gen(function* () {
      const store = yield* ThreadMcpServers.ThreadMcpServers;
      // Ids are not file names; one with a separator must not escape the store.
      const threadId = ThreadId.make("thread:1/../other");
      const otherThreadId = ThreadId.make("thread-2");

      assert.isUndefined(yield* store.read(threadId));
      yield* store.save(threadId, gem);
      assert.deepStrictEqual(yield* store.read(threadId), gem);
      assert.isUndefined(yield* store.read(otherThreadId));

      yield* store.remove(threadId);
      assert.isUndefined(yield* store.read(threadId));
      // Removing what is gone, as a retried cleanup does, succeeds.
      yield* store.remove(threadId);
    }).pipe(Effect.provide(layerStore())),
  );

  it.effect("a thread's servers outlive the process that saved them", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-restart");
      const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-mcp-restart-" });
      const shared = yield* Layer.build(config);
      const storeOver = () =>
        ThreadMcpServers.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(Layer.succeedContext(shared)),
        );
      yield* ThreadMcpServers.ThreadMcpServers.pipe(
        Effect.flatMap((store) => store.save(threadId, gem)),
        Effect.provide(storeOver()),
      );
      const read = yield* ThreadMcpServers.ThreadMcpServers.pipe(
        Effect.flatMap((store) => store.read(threadId)),
        Effect.provide(storeOver()),
      );
      assert.deepStrictEqual(read, gem);
    }).pipe(Effect.scoped),
  );
});
