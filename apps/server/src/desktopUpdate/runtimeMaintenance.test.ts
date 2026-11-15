// @effect-diagnostics nodeBuiltinImport:off -- The admission barrier is exercised in an isolated runtime directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeRuntimeMaintenanceGate } from "./runtimeMaintenance.ts";

function setup() {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-maintenance-"));
  const runtime = NodePath.join(baseDir, "runtime");
  NodeFS.mkdirSync(runtime);
  return {
    baseDir,
    ack: NodePath.join(runtime, "runtime-quiescent.json"),
    mark(expiresAt: number) {
      NodeFS.writeFileSync(
        NodePath.join(runtime, "runtime-maintenance.json"),
        JSON.stringify({ id: "update", expiresAt }),
      );
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

describe("runtime maintenance admission", () => {
  it.effect("acknowledges only after an already admitted command finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        using fixture = setup();
        const gate = yield* makeRuntimeMaintenanceGate(fixture.baseDir);
        const admitted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const command = yield* gate
          .withAdmission(
            Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        fixture.mark(120_000);
        assert.isTrue(yield* gate.active);
        yield* gate.acknowledge;
        assert.isFalse(NodeFS.existsSync(fixture.ack));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(command);
        yield* gate.acknowledge;
        assert.equal(NodeFS.readFileSync(fixture.ack, "utf8"), '{"id":"update"}');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([-1, 0, 120_001])("ignores an expired or invalid lease: %s", (expiresAt) =>
    Effect.scoped(
      Effect.gen(function* () {
        using fixture = setup();
        fixture.mark(expiresAt);
        const gate = yield* makeRuntimeMaintenanceGate(fixture.baseDir);
        assert.isFalse(yield* gate.active);
        yield* gate.acknowledge;
        assert.isFalse(NodeFS.existsSync(fixture.ack));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
