import { assert, it } from "@effect/vitest";
import type { GitHubLinkPreview } from "@t3tools/contracts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
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

const summary = (
  read: GitHubPullRequestApi.GitHubPullRequestApi["Service"]["getPullRequestSummary"],
) => Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({ getPullRequestSummary: read });
const noSummary = summary(() => Effect.die("unexpected summary read"));

const user = { login: "octocat", avatar_url: null, type: "User" };
const pull = (base: string) => ({
  title: "Fix login",
  state: "open",
  user,
  created_at: "2026-10-01T00:00:00Z",
  head: { ref: "fix-login" },
  base: { ref: base, repo: { default_branch: "main" } },
});

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
        pullRequest: {
          headBranch: "fix-login",
          baseBranch: "main",
          reviewDecision: "approved",
          checksState: "passing",
          parentUrl: null,
        },
      });
    }),
    Effect.provide(
      Layer.merge(
        summary((input) =>
          Effect.succeed({
            number: input.number,
            title: "Fix login",
            url: "https://github.com/acme/web/pull/7",
            headBranch: "fix-login",
            baseBranch: "main",
            state: "merged",
            updatedAt: "2026-10-02T00:00:00Z",
            reviewDecision: "approved",
            checksState: "passing",
          }),
        ),
        respond({
          "repos/acme/web/issues/7": {
            title: "Fix login",
            state: "closed",
            pull_request: {},
            user,
            created_at: "2026-10-01T00:00:00Z",
          },
          "repos/acme/web/pulls/7": {
            ...pull("main"),
            state: "closed",
            merged_at: "2026-10-02T00:00:00Z",
          },
        }),
      ),
    ),
  ),
);

it.effect("names the pull request a stacked one is based on", () =>
  gitHubLinkPreview("https://github.com/acme/web/pull/8").pipe(
    Effect.map((preview: GitHubLinkPreview | null) => {
      assert.deepStrictEqual(preview?.pullRequest, {
        headBranch: "fix-login",
        baseBranch: "auth/rework",
        reviewDecision: null,
        checksState: null,
        parentUrl: "https://github.com/acme/web/pull/7",
      });
    }),
    Effect.provide(
      Layer.merge(
        summary(() => Effect.fail(new Error("no graphql") as never)),
        respond({
          "repos/acme/web/issues/8": { ...pull("auth/rework"), pull_request: {} },
          "repos/acme/web/pulls/8": pull("auth/rework"),
          "repos/acme/web/pulls?state=all&per_page=1&head=acme:auth%2Frework": [
            { html_url: "https://github.com/acme/web/pull/7" },
          ],
        }),
      ),
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
      Layer.merge(
        noSummary,
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
      Layer.merge(
        noSummary,
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
      Layer.merge(
        noSummary,
        Layer.mock(GitHubRest.GitHubRest)({
          rest: () => Effect.fail(new Error("not found") as never),
        }),
      ),
    ),
  ),
);
