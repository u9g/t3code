import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

const decodeMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, expiresAt: Schema.Number })),
);
const encodeAcknowledgement = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

export const makeRuntimeMaintenanceGate = Effect.fn("desktopUpdate.makeRuntimeMaintenanceGate")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(baseDir, "runtime", "runtime-maintenance.json");
    const ackPath = path.join(baseDir, "runtime", "runtime-quiescent.json");
    let activeDispatches = 0;
    const marker = Effect.gen(function* () {
      const text = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""));
      const now = yield* Clock.currentTimeMillis;
      return Option.filter(
        decodeMarker(text),
        (value) => value.expiresAt > now && value.expiresAt <= now + 120_000,
      );
    });
    const active = marker.pipe(Effect.map(Option.isSome));
    const withAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        activeDispatches++;
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeDispatches--;
            }),
          ),
        );
      });
    const acknowledge = Effect.gen(function* () {
      const current = yield* marker;
      if (Option.isNone(current) || activeDispatches !== 0) return;
      const text = yield* encodeAcknowledgement({ id: current.value.id });
      // No admission can begin between the zero check and this synchronous decision.
      if (activeDispatches !== 0) return;
      yield* fs.writeFileString(`${ackPath}.tmp`, text);
      yield* fs.rename(`${ackPath}.tmp`, ackPath);
    });
    yield* acknowledge.pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced(Duration.millis(100))),
      Effect.forkScoped,
    );
    return { active, withAdmission, acknowledge };
  },
);
