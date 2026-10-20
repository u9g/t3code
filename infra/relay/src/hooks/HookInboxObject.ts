import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import * as HookInboxInstance from "./HookInboxInstance.ts";
import type * as HookInboxStore from "./HookInboxStore.ts";

type Call<A> = Effect.Effect<A, never, Alchemy.RuntimeContext>;

export class HookInboxObject extends Cloudflare.DurableObject<
  HookInboxObject,
  {
    /** Holds a request for `baseUrl`; false when the inbox is full and nothing was stored. */
    readonly hold: (hook: HookInboxStore.HeldHook, baseUrl: string) => Call<boolean>;
    readonly wake: (baseUrl: string) => Call<boolean>;
    readonly clear: () => Call<void>;
  }
>()("HookInboxObject") {}

export const layer = HookInboxObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // The init phase returns the per-instance Effect, which alchemy runs once
    // per object; only that inner Effect may touch storage.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.suspend(() =>
      HookInboxInstance.makeInstance({
        inboxId: state.raw.id.name ?? state.raw.id.toString(),
        layerSql: SqliteClient.layer({ storage: state.raw.storage }),
        alarm: {
          get: Effect.suspend(() => state.storage.getAlarm()),
          set: (at) => state.storage.setAlarm(at),
          clear: Effect.suspend(() => state.storage.deleteAlarm()),
        },
      }),
    );
  }),
);
