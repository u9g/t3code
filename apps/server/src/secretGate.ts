// secretgate (github.com/u9g/secretgate) gates the 1Password CLI behind Touch ID.
// While its prompt is on screen, `secretgate approve` writes ~/.secretgate/touchid.json
// naming the thread (T3CODE_THREAD_ID) whose agent asked, and removes it after.
import * as NodeOS from "node:os";

import type { SecretGatePrompt } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const OnScreen = Schema.fromJsonString(
  Schema.Struct({ thread_id: Schema.String, expires_at: Schema.String }),
);
const decodeOnScreen = Schema.decodeUnknownOption(OnScreen);

const NONE: SecretGatePrompt = { threadId: null };

/** The prompt the file's text names at now, and how long until it times out. */
export const parsePrompt = (
  text: string | null,
  now: number,
): { readonly prompt: SecretGatePrompt; readonly remainingMs: number } => {
  if (text === null) return { prompt: NONE, remainingMs: 0 };
  const onScreen = decodeOnScreen(text);
  if (onScreen._tag === "None" || onScreen.value.thread_id === "") {
    return { prompt: NONE, remainingMs: 0 };
  }
  // A file left by a crashed approver stops counting once its prompt would have timed out.
  const remainingMs = Date.parse(onScreen.value.expires_at) - now;
  if (!(remainingMs > 0)) return { prompt: NONE, remainingMs: 0 };
  return { prompt: { threadId: onScreen.value.thread_id }, remainingMs };
};

export const make = Effect.fn("SecretGate.make")(function* (
  file: string = NodeOS.homedir() + "/.secretgate/touchid.json",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.dirname(file);
  const name = path.basename(file);
  const read = Effect.gen(function* () {
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
    return parsePrompt(text, yield* Clock.currentTimeMillis);
  });
  // fs.watch needs the directory; secretgate makes it the same way.
  const changes = Stream.fromEffect(
    fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore),
  ).pipe(
    Stream.flatMap(() => fs.watch(dir)),
    Stream.filter((event) => path.basename(event.path) === name),
    // The approver renames the file in; one change can raise several events.
    Stream.debounce(Duration.millis(50)),
    Stream.catchCause(() => Stream.empty),
  );
  /** The prompt on screen now, then each change, until the subscriber goes. */
  const prompts: Stream.Stream<SecretGatePrompt> = Stream.concat(
    Stream.make(undefined),
    changes,
  ).pipe(
    Stream.mapEffect(() => read),
    Stream.switchMap(({ prompt, remainingMs }) =>
      prompt.threadId === null
        ? Stream.make(prompt)
        : Stream.concat(
            Stream.make(prompt),
            Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(remainingMs)), NONE)),
          ),
    ),
    Stream.changesWith((a, b) => a.threadId === b.threadId),
  );
  return { prompts };
});
