// @effect-diagnostics nodeBuiltinImport:off - The inbox directory lives on the pod's volume.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { MANAGED_ENDPOINT_KEY_PATTERN } from "../deploymentConfig.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as HookInboxInstance from "../hooks/HookInboxInstance.ts";

const INBOX_FILE = /^([0-9a-f]+)\.sqlite$/;

type Instance = HookInboxInstance.Instance<never>;

interface Inbox {
  readonly instance: Instance;
  readonly lock: Semaphore.Semaphore;
  readonly arm: (at: number) => Effect.Effect<void>;
}

/**
 * The Node counterpart of `HookInboxObject`: one SQLite file per environment
 * under `directory`, calls on one inbox serialized as a Durable Object
 * serializes them, and its alarm a timer. A restart re-arms every inbox found
 * on disk, so held webhooks outlive the pod as they outlive an object.
 */
export const layer = (directory: string) =>
  Layer.effect(
    HookInbox.HookInbox,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      yield* Effect.sync(() => NodeFS.mkdirSync(directory, { recursive: true }));
      const inboxes = new Map<string, Inbox>();
      const opening = yield* Semaphore.make(1);

      const open = (endpointKey: string) =>
        opening.withPermits(1)(
          Effect.gen(function* () {
            const existing = inboxes.get(endpointKey);
            if (existing) return existing;
            if (!MANAGED_ENDPOINT_KEY_PATTERN.test(endpointKey)) {
              return yield* Effect.die(new Error(`Invalid endpoint key '${endpointKey}'`));
            }
            const sql = yield* Layer.build(
              NodeSqliteClient.layer({
                filename: NodePath.join(directory, `${endpointKey}.sqlite`),
                readerWorker: false,
              }),
            ).pipe(Effect.orDie, Scope.provide(scope));
            const lock = yield* Semaphore.make(1);
            // Each set supersedes the timers before it; a stale timer wakes and exits.
            let generation = 0;
            let alarmAt: number | null = null;
            let inbox: Inbox | undefined;
            const fire = (at: number, armed: number) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                yield* Effect.sleep(Math.max(0, at - now));
                yield* lock.withPermits(1)(
                  Effect.gen(function* () {
                    if (armed !== generation || inbox === undefined) return;
                    alarmAt = null;
                    yield* inbox.instance.alarm();
                  }),
                );
              });
            const arm = (at: number) =>
              Effect.suspend(() => {
                alarmAt = at;
                generation += 1;
                return fire(at, generation).pipe(Effect.forkIn(scope), Effect.asVoid);
              });
            const instance = yield* HookInboxInstance.makeInstance({
              inboxId: endpointKey,
              layerSql: Layer.succeedContext(sql),
              alarm: {
                get: Effect.sync(() => alarmAt),
                set: arm,
                clear: Effect.sync(() => {
                  alarmAt = null;
                  generation += 1;
                }),
              },
            });
            inbox = { instance, lock, arm };
            inboxes.set(endpointKey, inbox);
            return inbox;
          }),
        );

      const call =
        (operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
        <A>(use: (instance: Instance) => Effect.Effect<A>) =>
          open(endpointKey).pipe(
            Effect.flatMap((inbox) => inbox.lock.withPermits(1)(use(inbox.instance))),
            Effect.catchCause((cause) =>
              Effect.fail(
                new HookInbox.HookInboxError({
                  operation,
                  endpointKey,
                  cause: Cause.squash(cause),
                }),
              ),
            ),
          );

      const onDisk = yield* Effect.sync(() =>
        NodeFS.readdirSync(directory).flatMap((file) => INBOX_FILE.exec(file)?.[1] ?? []),
      );
      // A delivery run with nothing due finds the next due time itself.
      for (const endpointKey of onDisk) {
        const inbox = yield* open(endpointKey);
        yield* inbox.arm(yield* Clock.currentTimeMillis);
      }

      return HookInbox.HookInbox.of({
        hold: ({ endpointKey, baseUrl, hook }) =>
          call("hold", endpointKey)((instance) => instance.hold(hook, baseUrl)),
        wake: ({ endpointKey, baseUrl }) =>
          call("wake", endpointKey)((instance) => instance.wake(baseUrl)),
        clear: ({ endpointKey }) => call("clear", endpointKey)((instance) => instance.clear()),
      });
    }),
  );
