import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SecretGate from "./secretGate.ts";

const onScreen = (threadId: string, expiresInMs: number) =>
  Effect.map(DateTime.now, (now) =>
    JSON.stringify({
      thread_id: threadId,
      expires_at: DateTime.formatIso(DateTime.add(now, { milliseconds: expiresInMs })),
    }),
  );

it("parsePrompt ignores a missing, malformed or expired file", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const file = (expires: string) => JSON.stringify({ thread_id: "t1", expires_at: expires });
  assert.deepEqual(SecretGate.parsePrompt(null, now).prompt, { threadId: null });
  assert.deepEqual(SecretGate.parsePrompt("{", now).prompt, { threadId: null });
  assert.deepEqual(SecretGate.parsePrompt(file("2026-11-02T11:59:59Z"), now).prompt, {
    threadId: null,
  });
  assert.deepEqual(SecretGate.parsePrompt(file("2026-11-02T12:01:00Z"), now), {
    prompt: { threadId: "t1" },
    remainingMs: 60_000,
  });
});

// Live: the debounce and the expiry run on real time.
it.live("follows the file as the approver writes and removes it, and its expiry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-secretgate-" });
    // As secretgate does: the directory may not exist until the first prompt.
    const file = path.join(dir, ".secretgate", "touchid.json");
    const { prompts } = yield* SecretGate.make(file);

    const seen = yield* Queue.unbounded<string | null>();
    yield* Stream.runForEach(prompts, (p) => Queue.offer(seen, p.threadId)).pipe(Effect.forkScoped);
    assert.strictEqual(yield* Queue.take(seen), null);

    // Written beside it and renamed in, as secretgate does.
    yield* fs.writeFileString(`${file}.tmp`, yield* onScreen("thread-1", 60_000));
    yield* fs.rename(`${file}.tmp`, file);
    assert.strictEqual(yield* Queue.take(seen), "thread-1");

    yield* fs.remove(file);
    assert.strictEqual(yield* Queue.take(seen), null);

    // A file the approver left behind stops counting at its expiry.
    yield* fs.writeFileString(file, yield* onScreen("thread-2", 300));
    assert.strictEqual(yield* Queue.take(seen), "thread-2");
    assert.strictEqual(yield* Queue.take(seen), null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
