import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    const result = yield* vcs.run({
      operation: "ClaudeCloudRepository.testkit",
      command: "git",
      args,
      cwd,
      timeoutMs: 15_000,
    });
    return result.stdout.trim();
  });

/**
 * A bare repository standing in for the one on GitHub. `serve` points a
 * checkout's ssh remotes (`git@github.com:o/r.git` and the like) at it, so
 * asking the remote sees what a test pushed there and never reaches GitHub.
 */
export const makeFakeGitHubRemote = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-remote-" });
  yield* git(path, "init", "-q", "--bare", "-b", "main");
  return {
    path,
    serve: (cwd: string, target = path) =>
      Effect.gen(function* () {
        // Otherwise git probes the command as OpenSSH and adds its options.
        yield* git(cwd, "config", "ssh.variant", "simple");
        // Git appends the host and the remote's command; the stand-in drops both.
        yield* git(
          cwd,
          "config",
          "core.sshCommand",
          `sh -c 'git upload-pack "$0"' '${target.replaceAll("\\", "/")}'`,
        );
      }),
    /** Moves the remote's HEAD, which is what makes a branch its default. */
    setDefaultBranch: (branch: string) =>
      git(path, `--git-dir=${path}`, "symbolic-ref", "HEAD", `refs/heads/${branch}`),
  };
});
