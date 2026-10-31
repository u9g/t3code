import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type ClaudeCloudRepositoryChoiceRequest,
  makeClaudeCloudRepositoryChooser,
} from "./ClaudeCloudRepositoryChoice.ts";

interface CliRun {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Record<string, string | undefined> | undefined;
  readonly prompt: string;
}

const encode = (text: string) => Stream.make(new TextEncoder().encode(text));

/** Stands in for `claude -p`: reads the prompt from stdin, then prints `stdout`. */
const fakeCli = (answer: {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) => {
  const runs: Array<CliRun> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("unexpected pipeline");
      const stdin = command.options.stdin;
      const prompt =
        typeof stdin === "object" && "stream" in stdin && typeof stdin.stream !== "string"
          ? yield* stdin.stream.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
              Effect.orDie,
            )
          : "";
      runs.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        env: command.options.env,
        prompt,
      });
      const stdout = encode(answer.stdout);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout,
        stderr: answer.stderr === undefined ? Stream.empty : encode(answer.stderr),
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { runs, spawner };
};

/** What `claude -p --output-format json` prints for a turn that ended on `answer`. */
const resultWith = (answer: unknown) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: answer,
  });

const REQUEST = {
  cwd: "/home/u/.t3/scratch/2026-10-19-rebase-pnpm-14673",
  messageText: "rebase https://github.com/pnpm/pnpm/pull/14673",
  model: "claude-opus-5-5",
  effortLevel: "high",
} satisfies ClaudeCloudRepositoryChoiceRequest;

const choose = (
  cli: ReturnType<typeof fakeCli>,
  request: ClaudeCloudRepositoryChoiceRequest = REQUEST,
  homeDirectory = "/home/u",
) =>
  Effect.gen(function* () {
    const chooseRepository = yield* makeClaudeCloudRepositoryChooser({
      binaryPath: "claude",
      environment: { CLAUDE_CONFIG_DIR: "/home/u/.claude-work", PATH: "/usr/bin" },
    });
    return yield* chooseRepository(request);
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
  );

const flagValue = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

it.layer(NodeServices.layer)("makeClaudeCloudRepositoryChooser", (it) => {
  describe("running Claude", () => {
    it.effect("gives it read-only tools and no way to end without an answer", () =>
      Effect.gen(function* () {
        const cli = fakeCli({
          stdout: resultWith({ repository: "u9g/pnpm", branch: "main", reason: "The fork." }),
        });
        yield* choose(cli);

        assert.lengthOf(cli.runs, 1);
        const run = cli.runs[0]!;
        assert.equal(run.command, "claude");
        assert.equal(run.cwd, REQUEST.cwd);
        assert.equal(flagValue(run.args, "--tools"), "Read,Grep,Glob,WebFetch,WebSearch");
        assert.equal(flagValue(run.args, "--allowedTools"), "Read,Grep,Glob,WebFetch,WebSearch");
        assert.equal(flagValue(run.args, "--permission-mode"), "dontAsk");
        assert.include(run.args, "--strict-mcp-config");
        assert.include(run.args, "--disable-slash-commands");
        assert.deepEqual(JSON.parse(flagValue(run.args, "--settings")!), {
          disableAllHooks: true,
        });
        assert.deepInclude(JSON.parse(flagValue(run.args, "--json-schema")!), {
          required: ["repository", "branch", "reason"],
          additionalProperties: false,
        });
        assert.equal(flagValue(run.args, "--model"), "claude-opus-5-5");
        assert.equal(flagValue(run.args, "--effort"), "high");
        assert.equal(flagValue(run.args, "--output-format"), "json");
        assert.equal(run.env?.CLAUDE_CONFIG_DIR, "/home/u/.claude-work");
        assert.equal(run.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
      }),
    );

    it.effect("sends the thread's message and the home folder to look in", () =>
      Effect.gen(function* () {
        const cli = fakeCli({
          stdout: resultWith({ repository: "pnpm/pnpm", branch: null, reason: "Linked." }),
        });
        yield* choose(cli, { ...REQUEST, effortLevel: undefined });

        const run = cli.runs[0]!;
        assert.include(
          run.prompt,
          "<request>\nrebase https://github.com/pnpm/pnpm/pull/14673\n</request>",
        );
        assert.include(run.prompt, "*/*/.git/config in /home/u");
        assert.include(run.prompt, "Do not carry out the request itself.");
        assert.notInclude(run.args, "--effort");
      }),
    );

    it.effect("lists the GitHub checkouts near the home folder in the prompt", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cloud-home-" });
        const writeFile = (relative: string, content: string) =>
          Effect.gen(function* () {
            const file = path.join(home, relative);
            yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
            yield* fileSystem.writeFileString(file, content);
          });
        yield* writeFile(
          "code/app/.git/config",
          [
            "[core]",
            "\tbare = false",
            '[remote "origin"]',
            "\turl = git@github.com:octo/app.git",
            "\tfetch = +refs/heads/*:refs/remotes/origin/*",
            '[remote "upstream"]',
            "\turl = https://github.com/upstream/app",
            '[branch "main"]',
            "\tremote = origin",
          ].join("\n"),
        );
        // A worktree's `.git` file, which shares the config of code/app.
        yield* writeFile("code/app/.git/worktrees/app-wt/commondir", "../..\n");
        yield* writeFile(
          "code/app-wt/.git",
          `gitdir: ${path.join(home, "code/app/.git/worktrees/app-wt")}\n`,
        );
        yield* writeFile(
          "solo/.git/config",
          '[remote "origin"]\n\turl = https://github.com/o/solo\n',
        );
        yield* writeFile(
          "code/lab/.git/config",
          '[remote "origin"]\n\turl = https://gitlab.com/o/lab\n',
        );
        yield* writeFile(
          "deep/a/b/.git/config",
          '[remote "origin"]\n\turl = https://github.com/o/deep\n',
        );
        yield* writeFile(
          "node_modules/dep/.git/config",
          '[remote "origin"]\n\turl = https://github.com/o/dep\n',
        );
        yield* writeFile(
          ".cache/x/.git/config",
          '[remote "origin"]\n\turl = https://github.com/o/x\n',
        );
        yield* writeFile(
          "Documents/notes/.git/config",
          '[remote "origin"]\n\turl = https://github.com/o/notes\n',
        );

        const cli = fakeCli({
          stdout: resultWith({ repository: "octo/app", branch: null, reason: "Cloned." }),
        });
        yield* choose(cli, REQUEST, home);

        const prompt = cli.runs[0]!.prompt;
        const listing = prompt.slice(
          prompt.indexOf(`Git checkouts in ${home}, with their GitHub remotes:`),
          prompt.indexOf("The request:"),
        );
        assert.deepEqual(listing.trim().split("\n").slice(1), [
          `- ${path.join(home, "code", "app")}: origin octo/app, upstream upstream/app`,
          `- ${path.join(home, "code", "app-wt")}: origin octo/app, upstream upstream/app`,
          `- ${path.join(home, "solo")}: origin o/solo`,
        ]);
        assert.include(prompt, "listed below with their GitHub remotes");
      }),
    );
  });

  describe("reading the answer", () => {
    it.effect("returns the repository, branch and reason Claude chose", () =>
      Effect.gen(function* () {
        const choice = yield* choose(
          fakeCli({
            stdout: resultWith({
              repository: "u9g/pnpm",
              branch: "projects-graph-overrides",
              reason: "The pull request's head branch is on the u9g fork.",
            }),
          }),
        );

        assert.deepEqual(choice, {
          repository: "u9g/pnpm",
          branch: "projects-graph-overrides",
          reason: "The pull request's head branch is on the u9g fork.",
        });
      }),
    );

    it.effect("reads the result from a list of messages too", () =>
      Effect.gen(function* () {
        const choice = yield* choose(
          fakeCli({
            stdout: JSON.stringify([
              { type: "system", subtype: "init" },
              JSON.parse(resultWith({ repository: "o/r", branch: null, reason: "Named." })),
            ]),
          }),
        );

        assert.equal(choice.repository, "o/r");
      }),
    );

    it.effect("takes a github.com link or remote for the repository", () =>
      Effect.gen(function* () {
        const repositoryFor = (repository: string) =>
          choose(fakeCli({ stdout: resultWith({ repository, branch: null, reason: "" }) })).pipe(
            Effect.map((choice) => choice.repository),
          );

        assert.equal(yield* repositoryFor("https://github.com/pnpm/pnpm.git"), "pnpm/pnpm");
        assert.equal(yield* repositoryFor("git@github.com:pnpm/pnpm.git"), "pnpm/pnpm");
        assert.equal(yield* repositoryFor("github.com/pnpm/pnpm"), "pnpm/pnpm");
        assert.equal(yield* repositoryFor(" pnpm/pnpm "), "pnpm/pnpm");
      }),
    );

    it.effect("starts from the default branch when the branch is not a branch name", () =>
      Effect.gen(function* () {
        const branchFor = (branch: string | null) =>
          choose(fakeCli({ stdout: resultWith({ repository: "o/r", branch, reason: "" }) })).pipe(
            Effect.map((choice) => choice.branch),
          );

        assert.equal(yield* branchFor("refs/heads/feat/x"), "feat/x");
        assert.isNull(yield* branchFor("the PR's branch"));
        assert.isNull(yield* branchFor("-delete"));
        assert.isNull(yield* branchFor("a..b"));
        assert.isNull(yield* branchFor(""));
        assert.isNull(yield* branchFor(null));
      }),
    );

    it.effect("says no repository was chosen when Claude names none, or not one on GitHub", () =>
      Effect.gen(function* () {
        const none = yield* choose(
          fakeCli({
            stdout: resultWith({
              repository: null,
              branch: null,
              reason: "The message names no project.",
            }),
          }),
        ).pipe(Effect.flip);
        const elsewhere = yield* choose(
          fakeCli({
            stdout: resultWith({
              repository: "https://gitlab.com/o/r",
              branch: null,
              reason: "It is on GitLab.",
            }),
          }),
        ).pipe(Effect.flip);

        assert.equal(none.reason, "not_chosen");
        assert.equal(none.detail, "The message names no project.");
        assert.equal(elsewhere.reason, "not_chosen");
      }),
    );

    it.effect("fails when Claude gives no usable answer", () =>
      Effect.gen(function* () {
        const failureOf = (answer: Parameters<typeof fakeCli>[0]) =>
          choose(fakeCli(answer)).pipe(Effect.flip);

        const refused = yield* failureOf({
          stdout: JSON.stringify({
            type: "result",
            subtype: "error_max_structured_output_retries",
            is_error: true,
            result: "Could not produce valid structured output.",
          }),
          exitCode: 1,
        });
        assert.equal(refused.reason, "failed");
        assert.equal(refused.detail, "Could not produce valid structured output.");

        const crashed = yield* failureOf({ stdout: "", stderr: "Not logged in\n", exitCode: 1 });
        assert.equal(crashed.detail, "Not logged in");

        const malformed = yield* failureOf({
          stdout: resultWith({ repository: "o/r", reason: "No branch field." }),
        });
        assert.equal(malformed.detail, "Claude's answer did not match its schema.");
      }),
    );
  });
});
