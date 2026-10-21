import type { GitHubLinkPreview, PullRequestActor } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Account = Schema.Struct({
  login: Schema.String,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.String),
});
const IssueOrPull = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
  user: Schema.NullOr(Account),
  created_at: Schema.String,
});
const Commit = Schema.Struct({
  sha: Schema.String,
  author: Schema.NullOr(Account),
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.Struct({ name: Schema.String, date: Schema.String })),
  }),
});
const Repository = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  owner: Account,
  created_at: Schema.String,
});
const User = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  bio: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
});

const actor = (account: typeof Account.Type | null): PullRequestActor | null =>
  account === null
    ? null
    : {
        login: account.login,
        name: null,
        avatarUrl: account.avatar_url ?? null,
        ...(account.type === "Bot" ? { isBot: true } : {}),
      };

/** github.com paths that are not accounts, so a one-segment link to them has no preview. */
const RESERVED_TOP_LEVEL = new Set([
  "about",
  "apps",
  "features",
  "issues",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
]);

/**
 * Reads the resource a github.com link points at through the server's GitHub account, so
 * private repositories preview too. Any link it cannot read resolves to null.
 */
export const gitHubLinkPreview = Effect.fn("PullRequests.gitHubLinkPreview")(
  function* (url: string) {
    const parsed = URL.parse(url);
    if (parsed === null || !/^(www\.)?github\.com$/u.test(parsed.hostname)) return null;
    const [owner, repo, section, id] = parsed.pathname.split("/").filter(Boolean);
    if (owner === undefined) return null;

    const github = yield* GitHubRest.GitHubRest;
    const read = <S extends Schema.Top>(schema: S, path: string) =>
      github
        .rest({ host: "github.com", operation: "linkPreview", path })
        .pipe(
          Effect.flatMap((response) =>
            Schema.decodeEffect(Schema.fromJsonString(schema))(response.body),
          ),
        );

    if (repo === undefined) {
      if (RESERVED_TOP_LEVEL.has(owner)) return null;
      const user = yield* read(User, `users/${owner}`);
      return {
        kind: "user",
        context: user.login,
        title: user.name ?? user.login,
        description: user.bio ?? null,
        state: null,
        author: { login: user.login, name: user.name, avatarUrl: user.avatar_url ?? null },
        createdAt: user.created_at,
      } satisfies GitHubLinkPreview;
    }

    const repository = `${owner}/${repo}`;
    if ((section === "pull" || section === "issues") && id !== undefined && /^\d+$/u.test(id)) {
      const item = yield* read(IssueOrPull, `repos/${repository}/issues/${id}`);
      const pull = item.pull_request !== undefined;
      const details =
        pull && item.merged_at === undefined
          ? yield* read(IssueOrPull, `repos/${repository}/pulls/${id}`)
          : item;
      return {
        kind: pull ? "pull-request" : "issue",
        context: `${repository} #${id}`,
        title: item.title,
        description: null,
        state:
          details.merged_at != null
            ? "merged"
            : details.state === "closed"
              ? "closed"
              : details.draft === true
                ? "draft"
                : "open",
        author: actor(item.user),
        createdAt: item.created_at,
      } satisfies GitHubLinkPreview;
    }

    if (section === "commit" && id !== undefined) {
      const commit = yield* read(Commit, `repos/${repository}/commits/${id}`);
      return {
        kind: "commit",
        context: `${repository} @ ${commit.sha.slice(0, 7)}`,
        title: commit.commit.message.split("\n")[0] || commit.sha.slice(0, 7),
        description: null,
        state: null,
        author:
          actor(commit.author) ??
          (commit.commit.author === null
            ? null
            : { login: commit.commit.author.name, name: null, avatarUrl: null }),
        createdAt: commit.commit.author?.date ?? null,
      } satisfies GitHubLinkPreview;
    }

    const repoInfo = yield* read(Repository, `repos/${repository}`);
    return {
      kind: "repository",
      context: repoInfo.full_name,
      title: repoInfo.full_name,
      description: repoInfo.description,
      state: null,
      author: actor(repoInfo.owner),
      createdAt: repoInfo.created_at,
    } satisfies GitHubLinkPreview;
  },
  Effect.orElseSucceed(() => null),
);
