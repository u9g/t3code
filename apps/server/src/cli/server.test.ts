// @effect-diagnostics nodeBuiltinImport:off - The test holds a real listener so the bind fails as it does in production.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SERVER_EXIT_CODE_PORT_IN_USE } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";

import { isAddressInUse, ServerPortInUseError } from "./server.ts";

const holdLoopbackPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

describe("server command", () => {
  it.effect("recognizes the bind failure on a port another process holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const holder = yield* holdLoopbackPort;
        const address = holder.address();
        if (address === null || typeof address === "string") throw new Error("no TCP address");

        const error = yield* Layer.build(
          NodeHttpServer.layer(NodeHttp.createServer, { port: address.port, host: "127.0.0.1" }),
        ).pipe(Effect.flip);

        expect(isAddressInUse(error)).toBe(true);
      }),
    ),
  );

  it("exits with the port-in-use code so a supervisor can move the port", () => {
    const error = new ServerPortInUseError({ host: "127.0.0.1", port: 3773 });
    expect(error[Runtime.errorExitCode]).toBe(SERVER_EXIT_CODE_PORT_IN_USE);
    expect(error.message).toContain("Port 3773 on 127.0.0.1 is already in use");
  });

  it("leaves other serve failures alone", () => {
    expect(isAddressInUse({ _tag: "ServeError", cause: { code: "EACCES" } })).toBe(false);
    expect(isAddressInUse({ _tag: "OtherError", cause: { code: "EADDRINUSE" } })).toBe(false);
  });
});
