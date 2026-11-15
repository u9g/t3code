import * as Effect from "effect/Effect";
import type { RuntimeBundle } from "./runtimeBundle.ts";

export const applyRuntimeUpdate = Effect.fn("desktop.runtimeUpdates.apply")(function* (input: {
  readonly runtime: RuntimeBundle;
  readonly current: RuntimeBundle | null;
  readonly stop: Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
  readonly ready: Effect.Effect<boolean>;
  readonly select: (runtime: RuntimeBundle | null) => void;
  readonly commit: () => void;
  readonly reload: Effect.Effect<void>;
}) {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* input.stop;
      const applied = yield* Effect.gen(function* () {
        input.select(input.runtime);
        yield* input.start;
        if (!(yield* input.ready)) return false;
        yield* Effect.sync(input.commit);
        return true;
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!applied) {
        yield* input.stop;
        input.select(input.current);
        yield* input.start;
        if (!(yield* input.ready))
          return yield* Effect.die(
            new Error("The previous backend could not be restored after a failed update"),
          );
        return false;
      }
      yield* input.reload;
      return true;
    }),
  );
});
