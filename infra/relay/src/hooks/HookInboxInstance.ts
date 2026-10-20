import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as HookInboxStore from "./HookInboxStore.ts";
import { sendUpstream, TUNNEL_OFFLINE_STATUS } from "./upstream.ts";

const UNREACHABLE_STATUSES = new Set([502, 503, 504, TUNNEL_OFFLINE_STATUS]);
/**
 * Statuses that mean the environment is there but did not take this request
 * yet: its task's queue is full (429) or it failed while handling it (500).
 * The environment drops a delivery id it has already run, so retrying is safe.
 */
const BUSY_STATUSES = new Set([429, 500]);
const RUN_FAILURE_RETRY_MS = 60_000;

const withInboxSpan =
  (name: string, inboxId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(name, { root: true, attributes: { "relay.hook.endpoint_key": inboxId } }),
    );

const deliver = (baseUrl: string, hook: HookInboxStore.HeldHook) =>
  sendUpstream(baseUrl, hook).pipe(
    Effect.result,
    Effect.map((result) => {
      // Unreachable or timed out: a timeout may still have run it, and the
      // environment drops a delivery id it has already seen.
      if (Result.isFailure(result)) {
        return { outcome: "unreachable" as const, reason: result.failure._tag };
      }
      if (Option.isNone(result.success))
        return { outcome: "unreachable" as const, reason: "timeout" };
      const status = result.success.value.status;
      const upstreamOutcome = result.success.value.outcome;
      const outcome: HookInboxStore.DeliveryOutcome = UNREACHABLE_STATUSES.has(status)
        ? "unreachable"
        : BUSY_STATUSES.has(status)
          ? "busy"
          : "delivered";
      return { outcome, reason: `status ${status}`, upstreamOutcome };
    }),
    Effect.tap(({ upstreamOutcome }) =>
      upstreamOutcome === undefined
        ? Effect.void
        : Effect.annotateCurrentSpan({ "relay.hook.upstream_outcome": upstreamOutcome }),
    ),
    Effect.tap(({ outcome, reason }) =>
      outcome === "delivered"
        ? Effect.void
        : Effect.logInfo("Held webhook not delivered yet", {
            outcome,
            reason,
            deliveryId: hook.id,
          }),
    ),
    Effect.map(({ outcome }) => outcome),
    Effect.provide(FetchHttpClient.layer),
  );

/** One wake-up time per inbox, as a Durable Object alarm holds it. */
export interface InboxAlarm<R> {
  readonly get: Effect.Effect<number | null, never, R>;
  readonly set: (at: number) => Effect.Effect<void, never, R>;
  readonly clear: Effect.Effect<void, never, R>;
}

/**
 * One environment's inbox over its own SQLite database. Callers serialize
 * calls on one inbox, as a Durable Object does.
 */
export const makeInstance = Effect.fnUntraced(function* <R>(input: {
  readonly inboxId: string;
  readonly layerSql: Layer.Layer<SqlClient.SqlClient>;
  readonly alarm: InboxAlarm<R>;
}) {
  const { inboxId, alarm } = input;
  const run = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
    effect.pipe(Effect.provide(input.layerSql), Effect.orDie);
  yield* run(HookInboxStore.migrate);

  const scheduleBy = (at: number) =>
    Effect.gen(function* () {
      const current = yield* alarm.get;
      if (current === null || current > at) yield* alarm.set(at);
    });

  return {
    hold: (hook: HookInboxStore.HeldHook, baseUrl: string) =>
      Effect.gen(function* () {
        const dueAt = yield* run(HookInboxStore.hold(hook, baseUrl));
        yield* Effect.annotateCurrentSpan({ "relay.inbox.stored": dueAt !== null });
        if (dueAt === null) return false;
        yield* scheduleBy(dueAt);
        return true;
      }).pipe(withInboxSpan("relay.inbox.hold", inboxId)),
    wake: (baseUrl: string) =>
      Effect.gen(function* () {
        const pending = yield* run(HookInboxStore.wake(baseUrl));
        yield* Effect.annotateCurrentSpan({ "relay.inbox.pending": pending });
        if (pending) yield* alarm.set(yield* Clock.currentTimeMillis);
        return pending;
      }).pipe(withInboxSpan("relay.inbox.wake", inboxId)),
    clear: () =>
      Effect.gen(function* () {
        yield* run(HookInboxStore.clear);
        yield* alarm.clear;
      }).pipe(withInboxSpan("relay.inbox.clear", inboxId)),
    alarm: () =>
      run(HookInboxStore.deliverDue(deliver)).pipe(
        // A wake during this run may already have asked for an earlier
        // run; a backoff must not push it out.
        Effect.flatMap((nextAt) => (nextAt === null ? Effect.void : scheduleBy(nextAt))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Held webhook delivery run failed", { cause }).pipe(
            Effect.andThen(Effect.annotateCurrentSpan({ "relay.inbox.run_result": "failed" })),
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((now) => scheduleBy(now + RUN_FAILURE_RETRY_MS)),
          ),
        ),
        withInboxSpan("relay.inbox.deliver", inboxId),
      ),
  };
});

export type Instance<R> = Effect.Success<ReturnType<typeof makeInstance<R>>>;
