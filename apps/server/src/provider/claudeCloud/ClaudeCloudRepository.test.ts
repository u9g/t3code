import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ClaudeCloudRepository from "./ClaudeCloudRepository.ts";
import { git, makeFakeGitHubRemote } from "./ClaudeCloudRepository.testkit.ts";

const layer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const writeFile = (cwd: string, name: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, name), contents);
  });

const commit = (cwd: string, name: string) =>
  Effect.gen(function* () {
    yield* writeFile(cwd, name, `${name}\n`);
    yield* git(cwd, "add", name);
    yield* git(cwd, "commit", "-q", "-m", name);
  });

/** A repo on `main` with one commit and the given remotes; nothing is fetched. */
const makeRepo = (remotes: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-repo-" });
    yield* git(cwd, "init", "-q", "-b", "main");
    yield* git(cwd, "config", "user.email", "test@example.com");
    yield* git(cwd, "config", "user.name", "Test");
    yield* git(cwd, "config", "commit.gpgsign", "false");
    yield* commit(cwd, "README.md");
    for (const [name, url] of Object.entries(remotes)) {
      yield* git(cwd, "remote", "add", name, url);
    }
    return cwd;
  });

/** Puts this checkout's HEAD on the remote as `branch`. */
const push = (cwd: string, remotePath: string, branch: string) =>
  git(cwd, "push", "-q", remotePath, `HEAD:refs/heads/${branch}`);

/** Records `branch` as pushed to `remote` the way `git push -u` leaves it. */
const trackPushed = (cwd: string, remote: string, branch: string) =>
  Effect.gen(function* () {
    yield* git(cwd, "update-ref", `refs/remotes/${remote}/${branch}`, "HEAD");
    yield* git(cwd, "config", `branch.${branch}.remote`, remote);
    yield* git(cwd, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
  });

const resolve = (cwd: string) =>
  ClaudeCloudRepository.resolveClaudeCloudRepository(cwd).pipe(Effect.result);

const noticeKinds = (source: ClaudeCloudRepository.ClaudeCloudRepositorySource) =>
  source.notices.map((notice) => notice.kind);

it.layer(layer)("resolveClaudeCloudRepository", (it) => {
  describe("pushed branches", () => {
    it.effect("starts from the upstream branch and normalizes the remote", () =>
      Effect.gen(function* () {
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({ origin: "git@github.com:Octo-Org/Octo-Repo.git" });
        yield* github.serve(cwd);
        yield* git(cwd, "checkout", "-q", "-b", "feat/cloud");
        yield* push(cwd, github.path, "feat/cloud");
        yield* trackPushed(cwd, "origin", "feat/cloud");
        expect(yield* resolve(cwd)).toEqual(
          Result.succeed({
            repoUrl: "https://github.com/Octo-Org/Octo-Repo",
            revision: "feat/cloud",
            notices: [],
          }),
        );
      }),
    );

    it.effect("notes unpushed commits and uncommitted changes", () =>
      Effect.gen(function* () {
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({ origin: "git@github.com:o/r.git" });
        yield* github.serve(cwd);
        yield* push(cwd, github.path, "main");
        yield* trackPushed(cwd, "origin", "main");
        yield* commit(cwd, "one.txt");
        yield* commit(cwd, "two.txt");
        yield* writeFile(cwd, "scratch.txt", "local\n");
        const result = yield* resolve(cwd);
        expect(Result.isSuccess(result)).toBe(true);
        if (!Result.isSuccess(result)) return;
        expect(result.success.revision).toBe("main");
        expect(result.success.notices).toEqual([
          {
            kind: "unpushed_commits",
            message:
              "2 local commits on `main` are not pushed, so the cloud session will not see them.",
          },
          {
            kind: "uncommitted_changes",
            message:
              "Uncommitted changes stay on this machine; the cloud session works from GitHub.",
          },
        ]);
      }),
    );

    it.effect("uses the remote the branch tracks rather than origin", () =>
      Effect.gen(function* () {
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({
          origin: "https://gitlab.com/o/r.git",
          fork: "ssh://git@github.com/me/r",
        });
        yield* github.serve(cwd);
        yield* push(cwd, github.path, "main");
        yield* trackPushed(cwd, "fork", "main");
        expect(yield* resolve(cwd)).toMatchObject(
          Result.succeed({
            repoUrl: "https://github.com/me/r",
            revision: "main",
          }),
        );
      }),
    );
  });

  describe("tracked branches gone from GitHub", () => {
    // How a merged pull request leaves a checkout: GitHub deleted the branch,
    // and its tracking ref stays until a fetch prunes it.
    const trackDeletedBranch = (cwd: string, remotePath: string, branch: string) =>
      Effect.gen(function* () {
        yield* git(cwd, "checkout", "-q", "-b", branch);
        yield* commit(cwd, "work.txt");
        yield* push(cwd, remotePath, branch);
        yield* trackPushed(cwd, "origin", branch);
        yield* git(cwd, "push", "-q", remotePath, "--delete", branch);
      });

    it.effect("starts from the remote's default branch, not its stale tracking ref", () =>
      Effect.gen(function* () {
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({ origin: "git@github.com:o/r.git" });
        yield* github.serve(cwd);
        yield* push(cwd, github.path, "trunk");
        yield* github.setDefaultBranch("trunk");
        // The local refs still name main as the default.
        yield* git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
        yield* git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        yield* trackDeletedBranch(cwd, github.path, "r-targeting-hint");

        expect(yield* resolve(cwd)).toEqual(
          Result.succeed({
            repoUrl: "https://github.com/o/r",
            revision: "trunk",
            notices: [
              {
                kind: "branch_gone_from_remote",
                message:
                  "Branch `r-targeting-hint` is no longer on GitHub (it may have been merged and deleted), so the cloud session starts from `trunk`.",
              },
            ],
          }),
        );
      }),
    );

    it.effect("leaves the default branch to GitHub when the remote names none", () =>
      Effect.gen(function* () {
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({ origin: "git@github.com:o/r.git" });
        yield* github.serve(cwd);
        yield* push(cwd, github.path, "trunk");
        yield* github.setDefaultBranch("unborn");
        yield* trackDeletedBranch(cwd, github.path, "merged");

        const result = yield* resolve(cwd);
        expect(result).toMatchObject(Result.succeed({ revision: null }));
        if (Result.isSuccess(result)) {
          expect(noticeKinds(result.success)).toEqual(["branch_gone_from_remote"]);
          expect(result.success.notices[0]?.message).toContain(
            "starts from the repository's default branch",
          );
        }
      }),
    );

    it.effect("trusts the tracking ref when GitHub cannot be reached", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const github = yield* makeFakeGitHubRemote;
        const cwd = yield* makeRepo({ origin: "git@github.com:o/r.git" });
        yield* trackDeletedBranch(cwd, github.path, "feat/offline");
        // Every request to the remote now fails, as it does offline.
        const offline = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-cloud-offline-",
        });
        yield* github.serve(cwd, path.join(offline, "missing.git"));

        expect(yield* resolve(cwd)).toEqual(
          Result.succeed({
            repoUrl: "https://github.com/o/r",
            revision: "feat/offline",
            notices: [],
          }),
        );
      }),
    );
  });

  describe("branches the cloud cannot see", () => {
    it.effect("falls back to the remote's default branch for an unpushed branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo({ origin: "https://token@github.com/o/r" });
        yield* git(cwd, "update-ref", "refs/remotes/origin/trunk", "HEAD");
        yield* git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
        yield* git(cwd, "checkout", "-q", "-b", "local-only");
        const result = yield* resolve(cwd);
        expect(result).toMatchObject(
          Result.succeed({
            repoUrl: "https://github.com/o/r",
            revision: "trunk",
            notices: [
              {
                kind: "branch_not_pushed",
                message:
                  "Branch `local-only` is not on GitHub, so the cloud session starts from `trunk`. Push the branch to start from it.",
              },
            ],
          }),
        );
      }),
    );

    it.effect("treats an upstream whose tracking ref is gone as unpushed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo({ origin: "https://github.com/o/r" });
        yield* git(cwd, "config", "branch.main.remote", "origin");
        yield* git(cwd, "config", "branch.main.merge", "refs/heads/main");
        const result = yield* resolve(cwd);
        expect(result).toMatchObject(Result.succeed({ revision: null }));
        if (Result.isSuccess(result)) {
          expect(noticeKinds(result.success)).toEqual(["branch_not_pushed"]);
          expect(result.success.notices[0]?.message).toContain(
            "starts from the repository's default branch",
          );
        }
      }),
    );

    it.effect("starts a detached checkout from the default branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo({ origin: "https://github.com/o/r" });
        yield* git(cwd, "update-ref", "refs/remotes/origin/master", "HEAD");
        yield* git(cwd, "checkout", "-q", "--detach");
        const result = yield* resolve(cwd);
        expect(result).toMatchObject(Result.succeed({ revision: "master" }));
        if (Result.isSuccess(result)) {
          expect(noticeKinds(result.success)).toEqual(["detached_head"]);
        }
      }),
    );
  });

  describe("projects the cloud cannot use", () => {
    it.effect("rejects a folder outside git", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-plain-" });
        const result = yield* resolve(cwd);
        expect(result).toMatchObject(
          Result.fail({ _tag: "ClaudeCloudRepositoryError", reason: "not_a_repository", cwd }),
        );
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe(
            "Claude Cloud needs a project backed by a GitHub repository, and this thread's folder is not a git repository. Start the thread in a project cloned from GitHub.",
          );
        }
      }),
    );

    it.effect("rejects a repository without remotes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        expect(yield* resolve(cwd)).toMatchObject(Result.fail({ reason: "no_remote" }));
      }),
    );

    it.effect("rejects a non-GitHub remote without exposing its URL", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo({ origin: "https://user:s3cret@gitlab.example.com/o/r.git" });
        const result = yield* resolve(cwd);
        expect(result).toMatchObject(
          Result.fail({
            reason: "not_github",
            remoteName: "origin",
            remoteHost: "gitlab.example.com",
          }),
        );
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe(
            'Claude Cloud works on GitHub repositories, and this project\'s remote "origin" points to gitlab.example.com.',
          );
          expect(JSON.stringify(result.failure)).not.toContain("s3cret");
        }
        const scp = yield* makeRepo({ origin: "git@bitbucket.org:o/r.git" });
        expect(yield* resolve(scp)).toMatchObject(
          Result.fail({ reason: "not_github", remoteHost: "bitbucket.org" }),
        );
      }),
    );
  });
});
