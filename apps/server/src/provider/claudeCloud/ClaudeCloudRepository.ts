import type { VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

const GIT_TIMEOUT_MS = 15_000;
// Asking GitHub can stall on a slow network; past this the local tracking ref
// is trusted, as it was before the check.
const REMOTE_CHECK_TIMEOUT_MS = 10_000;
// Nobody can answer a credential prompt from the server, so git fails instead
// of asking. Stored credentials from the user's helper still apply.
const NON_INTERACTIVE_GIT_ENV = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv;
// What `git ls-remote --exit-code` exits with when no ref matched.
const LS_REMOTE_NO_MATCH = 2;

const REPOSITORY_FAILURES = {
  not_a_repository:
    "Claude Cloud needs a project backed by a GitHub repository, and this thread's folder is not a git repository. Start the thread in a project cloned from GitHub.",
  no_remote:
    "Claude Cloud works on a GitHub repository, and this project has no git remote. Push it to GitHub first.",
  not_github:
    "Claude Cloud works on GitHub repositories, and this project's remote is not on github.com.",
} as const;

export class ClaudeCloudRepositoryError extends Schema.TaggedError<ClaudeCloudRepositoryError>()(
  "ClaudeCloudRepositoryError",
  {
    reason: Schema.Literals(
      Object.keys(REPOSITORY_FAILURES) as Array<keyof typeof REPOSITORY_FAILURES>,
    ),
    cwd: Schema.String,
    remoteName: Schema.optional(Schema.String),
    /** Only the host: remote URLs can embed credentials. */
    remoteHost: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.reason === "not_github" && this.remoteName !== undefined) {
      const where = this.remoteHost === undefined ? "outside github.com" : `to ${this.remoteHost}`;
      return `Claude Cloud works on GitHub repositories, and this project's remote "${this.remoteName}" points ${where}.`;
    }
    return REPOSITORY_FAILURES[this.reason];
  }
}

export type ClaudeCloudRepositoryNoticeKind =
  | "branch_not_pushed"
  | "branch_gone_from_remote"
  | "detached_head"
  | "unpushed_commits"
  | "uncommitted_changes";

/** Something local the cloud session will not see; `message` is user-facing. */
export interface ClaudeCloudRepositoryNotice {
  readonly kind: ClaudeCloudRepositoryNoticeKind;
  readonly message: string;
}

export interface ClaudeCloudRepositorySource {
  /** `https://github.com/<owner>/<repo>` */
  readonly repoUrl: string;
  /** What the cloud checks out; null leaves it to GitHub's default branch. */
  readonly revision: string | null;
  readonly notices: ReadonlyArray<ClaudeCloudRepositoryNotice>;
}

/** `owner/repo` for a github.com remote in any form git accepts, else null. */
export const parseGitHubRepository = (remoteUrl: string): string | null => {
  const url = remoteUrl.trim();
  const scp = /^(?:[^@\s/]+@)?github\.com:\/?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (scp?.[1]) return scp[1];
  try {
    const parsed = new URL(url);
    if (!/^(?:https?|ssh|git|git\+ssh|ssh\+git):$/i.test(parsed.protocol)) return null;
    if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return null;
    const match = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

const remoteHostOf = (remoteUrl: string): string | undefined => {
  const url = remoteUrl.trim();
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)/.exec(url);
  if (scp?.[1] && scp[1].length > 1) return scp[1].toLowerCase();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
};

const startingPoint = (revision: string | null) =>
  revision === null ? "the repository's default branch" : `\`${revision}\``;

/**
 * Resolves the GitHub repository and revision a cloud session for `cwd` starts
 * from: the current branch's upstream remote (else `origin`, else the first
 * remote), and the upstream branch when it is pushed there, else the remote's
 * default branch. It never fetches. A tracking ref outlives the branch it
 * tracks (one merged and deleted on GitHub stays until a pruning fetch), and
 * the cloud cannot start from a branch that is gone, so a tracked branch is
 * confirmed with the remote first.
 */
export const resolveClaudeCloudRepository = Effect.fn("resolveClaudeCloudRepository")(function* (
  cwd: string,
) {
  const vcs = yield* VcsProcess.VcsProcess;
  const git = (operation: string, args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: `ClaudeCloudRepository.${operation}`,
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout.trim() })));
  const gitValue = (operation: string, args: ReadonlyArray<string>) =>
    git(operation, args).pipe(
      Effect.map((result) => (result.ok && result.stdout.length > 0 ? result.stdout : null)),
    );
  const refExists = (ref: string) =>
    git("refExists", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
      Effect.map((result) => result.ok),
    );
  const askRemote = (operation: string, args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: `ClaudeCloudRepository.${operation}`,
        command: "git",
        args,
        cwd,
        env: NON_INTERACTIVE_GIT_ENV,
        allowNonZeroExit: true,
        timeoutMs: REMOTE_CHECK_TIMEOUT_MS,
      })
      .pipe(Effect.result);

  if (!(yield* git("insideWorkTree", ["rev-parse", "--is-inside-work-tree"])).ok) {
    return yield* new ClaudeCloudRepositoryError({ reason: "not_a_repository", cwd });
  }

  const branch = yield* gitValue("currentBranch", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remotes = ((yield* gitValue("listRemotes", ["remote"])) ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const upstreamRemote =
    branch === null
      ? null
      : yield* gitValue("upstreamRemote", ["config", "--get", `branch.${branch}.remote`]);
  const remoteName =
    upstreamRemote !== null && remotes.includes(upstreamRemote)
      ? upstreamRemote
      : remotes.includes("origin")
        ? "origin"
        : remotes[0];
  if (remoteName === undefined) {
    return yield* new ClaudeCloudRepositoryError({ reason: "no_remote", cwd });
  }

  const remoteUrl = (yield* gitValue("remoteUrl", ["remote", "get-url", remoteName])) ?? "";
  const repository = parseGitHubRepository(remoteUrl);
  if (repository === null) {
    const remoteHost = remoteHostOf(remoteUrl);
    return yield* new ClaudeCloudRepositoryError({
      reason: "not_github",
      cwd,
      remoteName,
      ...(remoteHost === undefined ? {} : { remoteHost }),
    });
  }

  const notices: Array<ClaudeCloudRepositoryNotice> = [];
  const upstreamMerge =
    branch !== null && upstreamRemote === remoteName
      ? yield* gitValue("upstreamMerge", ["config", "--get", `branch.${branch}.merge`])
      : null;
  const upstreamBranch = upstreamMerge?.startsWith("refs/heads/")
    ? upstreamMerge.slice("refs/heads/".length)
    : null;
  const trackingRef =
    upstreamBranch === null ? null : `refs/remotes/${remoteName}/${upstreamBranch}`;

  const branchOnRemote =
    trackingRef !== null && upstreamBranch !== null && (yield* refExists(trackingRef))
      ? yield* remoteHasBranch(remoteName, upstreamBranch, askRemote)
      : "untracked";

  let revision: string | null;
  if (upstreamBranch !== null && (branchOnRemote === "present" || branchOnRemote === "unknown")) {
    revision = upstreamBranch;
    const ahead = Number(
      (yield* gitValue("aheadCount", ["rev-list", "--count", `${trackingRef}..HEAD`])) ?? "0",
    );
    if (ahead > 0) {
      notices.push({
        kind: "unpushed_commits",
        message: `${ahead} local ${ahead === 1 ? "commit" : "commits"} on \`${branch}\` ${ahead === 1 ? "is" : "are"} not pushed, so the cloud session will not see ${ahead === 1 ? "it" : "them"}.`,
      });
    }
  } else if (upstreamBranch !== null && branchOnRemote === "missing") {
    // The local refs describe the remote as it was, so its default branch
    // comes from the remote too.
    revision = yield* remoteDefaultBranch(remoteName, askRemote);
    notices.push({
      kind: "branch_gone_from_remote",
      message: `Branch \`${upstreamBranch}\` is no longer on GitHub (it may have been merged and deleted), so the cloud session starts from ${startingPoint(revision)}.`,
    });
  } else {
    revision = yield* resolveDefaultBranch(remoteName, gitValue, refExists);
    notices.push(
      branch === null
        ? {
            kind: "detached_head",
            message: `This checkout is not on a branch, so the cloud session starts from ${startingPoint(revision)}.`,
          }
        : {
            kind: "branch_not_pushed",
            message: `Branch \`${branch}\` is not on GitHub, so the cloud session starts from ${startingPoint(revision)}. Push the branch to start from it.`,
          },
    );
  }

  if ((yield* gitValue("workingTreeStatus", ["status", "--porcelain"])) !== null) {
    notices.push({
      kind: "uncommitted_changes",
      message: "Uncommitted changes stay on this machine; the cloud session works from GitHub.",
    });
  }

  return {
    repoUrl: `https://github.com/${repository}`,
    revision,
    notices,
  } satisfies ClaudeCloudRepositorySource;
});

const resolveDefaultBranch = Effect.fn("ClaudeCloudRepository.resolveDefaultBranch")(function* <
  E,
  R,
>(
  remoteName: string,
  gitValue: (operation: string, args: ReadonlyArray<string>) => Effect.Effect<string | null, E, R>,
  refExists: (ref: string) => Effect.Effect<boolean, E, R>,
) {
  const remoteHead = yield* gitValue("remoteHead", [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remoteName}/HEAD`,
  ]);
  if (remoteHead?.startsWith(`${remoteName}/`)) {
    return remoteHead.slice(remoteName.length + 1);
  }
  for (const candidate of ["main", "master"]) {
    if (yield* refExists(`refs/remotes/${remoteName}/${candidate}`)) return candidate;
  }
  return null;
});

type AskRemote = (
  operation: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<Result.Result<VcsProcess.VcsProcessOutput, VcsError>>;

/**
 * Whether `branch` is on the remote now. "unknown" when the remote could not
 * be asked (offline, or no stored credentials for a private repository), and
 * then the caller keeps trusting the local tracking ref.
 */
const remoteHasBranch = Effect.fn("ClaudeCloudRepository.remoteHasBranch")(function* (
  remoteName: string,
  branch: string,
  askRemote: AskRemote,
) {
  const ref = `refs/heads/${branch}`;
  // A pattern also matches refs that merely end in it, so the full ref is
  // looked for in the answer.
  const answer = yield* askRemote("remoteBranch", [
    "ls-remote",
    "--heads",
    "--exit-code",
    remoteName,
    ref,
  ]);
  if (Result.isSuccess(answer)) {
    const { exitCode, stdout } = answer.success;
    if (exitCode === 0 || exitCode === LS_REMOTE_NO_MATCH) {
      const listed = stdout.split("\n").some((line) => line.split("\t")[1]?.trim() === ref);
      return listed ? ("present" as const) : ("missing" as const);
    }
  }
  yield* Effect.logWarning(
    "Claude Cloud could not ask the git remote for the branch, so it trusts the tracking ref.",
    {
      remoteName,
      ...(Result.isSuccess(answer)
        ? { exitCode: answer.success.exitCode }
        : { failure: answer.failure._tag }),
    },
  );
  return "unknown" as const;
});

/** The remote's HEAD branch, or null to leave the choice to GitHub. */
const remoteDefaultBranch = (remoteName: string, askRemote: AskRemote) =>
  askRemote("remoteDefaultBranch", ["ls-remote", "--symref", remoteName, "HEAD"]).pipe(
    Effect.map((answer) =>
      Result.isSuccess(answer) && answer.success.exitCode === 0
        ? (/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m.exec(answer.success.stdout)?.[1] ?? null)
        : null,
    ),
  );
