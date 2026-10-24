import { assert, it } from "@effect/vitest";
import * as GitHubRest from "./GitHubRest.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { gitHubLinkPreview } from "./gitHubLinkPreview.ts";

const respond = (bodies: Record<string, unknown>) =>
  Layer.mock(GitHubRest.GitHubRest)({
    rest: (input) =>
      input.path in bodies
        ? Effect.succeed({
            status: 200,
            headers: {},
            body: JSON.stringify(bodies[input.path]),
            truncated: false,
            invalidUtf8: false,
          })
        : Effect.die(`unexpected path ${input.path}`),
  });

const user = { login: "octocat", avatar_url: null, type: "User" };

it.effect("previews a merged pull request through the pulls endpoint", () =>
  gitHubLinkPreview("https://github.com/acme/web/pull/7/files").pipe(
    Effect.map((preview) => {
      assert.deepStrictEqual(preview, {
        kind: "pull-request",
        context: "acme/web #7",
        title: "Fix login",
        description: null,
        state: "merged",
        author: { login: "octocat", name: null, avatarUrl: null },
        createdAt: "2026-10-01T00:00:00Z",
      });
    }),
    Effect.provide(
      respond({
        "repos/acme/web/issues/7": {
          title: "Fix login",
          state: "closed",
          pull_request: {},
          user,
          created_at: "2026-10-01T00:00:00Z",
        },
        "repos/acme/web/pulls/7": {
          title: "Fix login",
          state: "closed",
          merged_at: "2026-10-02T00:00:00Z",
          user,
          created_at: "2026-10-01T00:00:00Z",
        },
      }),
    ),
  ),
);

it.effect("previews an issue without a second request", () =>
  gitHubLinkPreview("https://github.com/acme/web/issues/3").pipe(
    Effect.map((preview) => {
      assert.strictEqual(preview?.kind, "issue");
      assert.strictEqual(preview?.state, "open");
    }),
    Effect.provide(
      respond({
        "repos/acme/web/issues/3": {
          title: "Crash on start",
          state: "open",
          user,
          created_at: "2026-10-01T00:00:00Z",
        },
      }),
    ),
  ),
);

it.effect("previews the lines a file link selects", () =>
  gitHubLinkPreview("https://github.com/acme/web/blob/main/src/app.ts#L2-L3").pipe(
    Effect.map((preview) => {
      assert.deepStrictEqual(preview, {
        kind: "file",
        context: "acme/web @ main",
        title: "src/app.ts",
        description: null,
        state: null,
        author: null,
        createdAt: null,
        code: { startLine: 2, text: "two\nthree" },
      });
    }),
    Effect.provide(
      Layer.mock(GitHubRest.GitHubRest)({
        rest: (input) =>
          input.path === "repos/acme/web/contents/src/app.ts?ref=main"
            ? Effect.succeed({
                status: 200,
                headers: {},
                body: "one\ntwo\nthree\nfour",
                truncated: false,
                invalidUtf8: false,
              })
            : Effect.die(`unexpected path ${input.path}`),
      }),
    ),
  ),
);

it.effect("has no preview for non-GitHub links or failed reads", () =>
  Effect.all([
    gitHubLinkPreview("https://example.com/acme/web/pull/7"),
    gitHubLinkPreview("https://github.com/acme/web/pull/404"),
    gitHubLinkPreview("https://github.com/settings"),
  ]).pipe(
    Effect.map((previews) => assert.deepStrictEqual(previews, [null, null, null])),
    Effect.provide(
      Layer.mock(GitHubRest.GitHubRest)({
        rest: () => Effect.fail(new Error("not found") as never),
      }),
    ),
  ),
);
