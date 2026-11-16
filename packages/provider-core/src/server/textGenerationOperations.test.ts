import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect("returns the icon picked with a title, and drops one that is not an icon name", () =>
  Effect.gen(function* () {
    const titleWithIcon = (icon: string) =>
      fromRunner("Stub", (request) =>
        decodeJsonReply(
          request,
          "Stub",
          JSON.stringify({ title: "Claude Sign-In Failure", needsRefinement: false, icon }),
        ),
      ).generateThreadTitle({
        cwd: process.cwd(),
        message: "why does claude sign-in fail?",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      });

    assert.strictEqual((yield* titleWithIcon(" Key-Round ")).icon, "key-round");
    assert.isUndefined((yield* titleWithIcon("a key")).icon);
    assert.isUndefined((yield* titleWithIcon("")).icon);
  }),
);
