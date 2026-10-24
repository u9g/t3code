import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { hasClaudeManagedMcpConfig } from "../Drivers/ClaudeHome.ts";
import { parseGitHubRepository } from "./ClaudeCloudRepository.ts";

// Reading the disk and the web takes a while, and the thread's first turn waits
// on the answer.
const CHOICE_TIMEOUT = "3 minutes";
/**
 * All Claude can do here: read this machine's files and the web. `--tools` is
 * the whole built-in tool set, so Bash, edits and subagents do not exist for
 * it, and in dontAsk mode a call to anything else is refused.
 */
const CHOOSER_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";
// The user's hooks would run around every read.
const CHOOSER_SETTINGS = JSON.stringify({ disableAllHooks: true });
const OWNER_AND_NAME = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/u;
// Git's rules for a branch name, enough to turn down a sentence or a path.
const BRANCH_NAME = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock$|\/$|\.$))[^\s\p{Cc}~^:?*[\\]+$/u;
// Checkouts are listed this many folders inside the home folder, as `~/code/app` is.
const CHECKOUT_DEPTH = 2;
const MAX_LISTED_CHECKOUTS = 300;
// A slow or huge home folder leaves the search to Claude instead.
const CHECKOUT_LISTING_TIMEOUT = "5 seconds";

/** The repository a cloud session for a thread without a project starts from. */
export const ClaudeCloudRepositoryChoice = Schema.Struct({
  /** `owner/name` on github.com. */
  repository: Schema.String,
  /** What the cloud checks out; null leaves it to GitHub's default branch. */
  branch: Schema.NullOr(Schema.String),
  /** Why, in a sentence the thread shows. */
  reason: Schema.String,
});
export type ClaudeCloudRepositoryChoice = typeof ClaudeCloudRepositoryChoice.Type;

export class ClaudeCloudRepositoryChoiceError extends Schema.TaggedError<ClaudeCloudRepositoryChoiceError>()(
  "ClaudeCloudRepositoryChoiceError",
  {
    /** `not_chosen`: Claude answered, with no repository. `failed`: it gave no usable answer. */
    reason: Schema.Literals(["not_chosen", "failed"]),
    /** What Claude or the CLI said. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not_chosen"
      ? "Claude could not tell which GitHub repository the thread is for."
      : "Claude could not choose a GitHub repository for the thread.";
  }
}

export interface ClaudeCloudRepositoryChoiceRequest {
  /** The folder Claude runs in. */
  readonly cwd: string;
  /** The message the thread starts with. */
  readonly messageText: string;
  /** The thread's model, as the API names it. */
  readonly model: string;
  readonly effortLevel: string | undefined;
}

export type ChooseClaudeCloudRepository = (
  request: ClaudeCloudRepositoryChoiceRequest,
) => Effect.Effect<ClaudeCloudRepositoryChoice, ClaudeCloudRepositoryChoiceError>;

const ANSWER_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    repository: {
      type: ["string", "null"],
      description:
        "The repository as owner/name on github.com, or null when nothing points to one.",
    },
    branch: {
      type: ["string", "null"],
      description: "The branch to check out, or null for the repository's default branch.",
    },
    reason: {
      type: "string",
      description: "One short sentence, shown to the user, on why this repository and branch.",
    },
  },
  required: ["repository", "branch", "reason"],
  additionalProperties: false,
});

const Answer = Schema.Struct({
  repository: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
const decodeAnswer = Schema.decodeUnknownOption(Answer);

const CliResult = Schema.Struct({
  type: Schema.Literal("result"),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.String),
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isCliResult = Schema.is(CliResult);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const choicePrompt = (
  messageText: string,
  homeDirectory: string,
  checkouts: ReadonlyArray<string>,
) =>
  [
    "A Claude Code cloud session is about to start for the request below. It runs in Anthropic's cloud, on a fresh checkout of one GitHub repository. Choose that repository, and the branch to check out when the request needs a particular one. Do not carry out the request itself.",
    "",
    "You can read files on this machine and fetch web pages. You cannot run commands or change anything.",
    "",
    "How to choose:",
    "- A repository the request names or links is the one: owner/name, or a github.com link to it or to one of its issues, pull requests or commits.",
    "- To work on a pull request (rebase it, fix it, answer its review), start from its head repository and head branch. For a pull request from a fork, that is the fork. Fetch the pull request's page to find them.",
    checkouts.length === 0
      ? `- A project named without its owner may be cloned on this machine. Find checkouts with the Glob patterns */.git/config and */*/.git/config in ${homeDirectory}, not by searching the whole disk; each .git/config holds its checkout's remotes.`
      : "- A project named without its owner may be cloned on this machine. The git checkouts near the home folder are listed below with their GitHub remotes; read their files when the names alone do not settle it.",
    "- Leave branch null to start from the repository's default branch.",
    "- When nothing points to one repository, answer with repository null and say in reason what is missing.",
    "- Do not read credentials, tokens or other secrets.",
    ...(checkouts.length === 0
      ? []
      : ["", `Git checkouts in ${homeDirectory}, with their GitHub remotes:`, ...checkouts]),
    "",
    "The request:",
    "<request>",
    messageText,
    "</request>",
  ].join("\n");

/** `name owner/repo` for each github.com remote in a git config file. */
const gitHubRemotesIn = (config: string): ReadonlyArray<string> => {
  const remotes: Array<string> = [];
  let remote: string | undefined;
  for (const line of config.split(/\r?\n/u)) {
    const section = /^\s*\[(.*)\]\s*$/u.exec(line)?.[1];
    if (section !== undefined) {
      remote = /^remote\s+"(.+)"$/u.exec(section.trim())?.[1];
      continue;
    }
    const url = remote === undefined ? undefined : /^\s*url\s*=\s*(.+?)\s*$/u.exec(line)?.[1];
    const repository = url === undefined ? null : parseGitHubRepository(url);
    if (repository !== null) remotes.push(`${remote} ${repository}`);
  }
  return remotes;
};

/**
 * The git checkouts one or two folders inside the home folder (`~/code/app`)
 * that have a GitHub remote, as lines for the prompt. Claude would otherwise
 * search the disk for them one call at a time, which takes minutes. A
 * worktree's `.git` file points to the config it shares with its repository.
 */
const listGitHubCheckouts = Effect.fn("listGitHubCheckouts")(function* (homeDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => fileSystem.readFileString(file).pipe(Effect.option);
  const configOf = Effect.fnUntraced(function* (folder: string) {
    const dotGit = path.join(folder, ".git");
    const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
    if (Option.isNone(info)) return Option.none<string>();
    if (info.value.type === "Directory") return yield* read(path.join(dotGit, "config"));
    const pointer = yield* read(dotGit);
    const gitDir = Option.isSome(pointer)
      ? /^gitdir:\s*(.+?)\s*$/mu.exec(pointer.value)?.[1]
      : undefined;
    if (gitDir === undefined) return Option.none<string>();
    const worktreeGitDir = path.resolve(folder, gitDir);
    const commonDir = yield* read(path.join(worktreeGitDir, "commondir"));
    const sharedGitDir = Option.isSome(commonDir)
      ? path.resolve(worktreeGitDir, commonDir.value.trim())
      : worktreeGitDir;
    return yield* read(path.join(sharedGitDir, "config"));
  });
  const lines: Array<string> = [];
  // Untraced: it runs once per folder it walks, inside listGitHubCheckouts' span.
  const visit: (folder: string, depth: number) => Effect.Effect<void> = Effect.fnUntraced(
    function* (folder, depth) {
      const names = yield* fileSystem
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of [...names].sort()) {
        if (lines.length >= MAX_LISTED_CHECKOUTS) return;
        if (name.startsWith(".") || name === "node_modules") continue;
        const child = path.join(folder, name);
        const config = yield* configOf(child);
        if (Option.isSome(config)) {
          const remotes = gitHubRemotesIn(config.value);
          if (remotes.length > 0) lines.push(`- ${child}: ${remotes.join(", ")}`);
        } else if (depth < CHECKOUT_DEPTH) {
          yield* visit(child, depth + 1);
        }
      }
    },
  );
  yield* visit(homeDirectory, 1);
  return lines;
});

/** `owner/name` from Claude's answer, which may be a github.com URL, else null. */
const normalizeRepository = (answer: string): string | null => {
  const value = answer.trim().replace(/^(?:www\.)?github\.com\//iu, "");
  const repository = parseGitHubRepository(
    value.includes(":") ? value : `https://github.com/${value}`,
  );
  return repository !== null && OWNER_AND_NAME.test(repository) ? repository : null;
};

const normalizeBranch = (answer: string | null): string | null => {
  const value = answer?.trim().replace(/^refs\/heads\//u, "");
  return value !== undefined && BRANCH_NAME.test(value) ? value : null;
};

/**
 * Has the claude CLI on this machine choose the GitHub repository a thread
 * without a project works on, from the thread's first message. It runs with
 * read-only tools, and `--json-schema` makes it end on its answer.
 */
export const makeClaudeCloudRepositoryChooser = Effect.fn("makeClaudeCloudRepositoryChooser")(
  function* (input: {
    readonly binaryPath: string;
    /** The CLI's environment; carries CLAUDE_CONFIG_DIR for a configured config dir. */
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    const homeDirectory = yield* HostProcess.HomeDirectory;
    // claude.ai's connectors are found outside the MCP config, so they are
    // turned off separately.
    const environment = { ...input.environment, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    const failed = (detail: string, cause?: unknown) =>
      new ClaudeCloudRepositoryChoiceError({ reason: "failed", detail, cause });

    const choose = Effect.fn("ClaudeCloudRepositoryChooser.choose")(function* (
      request: ClaudeCloudRepositoryChoiceRequest,
    ) {
      // Claude refuses --strict-mcp-config next to a managed-mcp.json, which
      // already keeps the user's own MCP servers out.
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const checkouts = yield* listGitHubCheckouts(homeDirectory).pipe(
        Effect.timeoutOption(CHECKOUT_LISTING_TIMEOUT),
        Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
      );
      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        ANSWER_JSON_SCHEMA,
        "--model",
        request.model,
        ...(request.effortLevel === undefined ? [] : ["--effort", request.effortLevel]),
        "--settings",
        CHOOSER_SETTINGS,
        "--tools",
        CHOOSER_TOOLS,
        "--allowedTools",
        CHOOSER_TOOLS,
        "--disable-slash-commands",
        ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
        "--permission-mode",
        "dontAsk",
      ];
      const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, args, {
        env: environment,
      });
      const run = yield* spawnAndCollect(
        input.binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: request.cwd,
          env: environment,
          shell: spawnCommand.shell,
          stdin: {
            stream: Stream.encodeText(
              Stream.make(choicePrompt(request.messageText, homeDirectory, checkouts)),
            ),
          },
        }),
      ).pipe(
        Effect.timeoutOption(CHOICE_TIMEOUT),
        Effect.mapError((cause) => failed("The claude CLI could not be run.", cause)),
      );
      if (Option.isNone(run)) {
        return yield* failed("Claude did not answer within three minutes.");
      }
      const { stdout, stderr, code } = run.value;
      const output = Option.getOrUndefined(decodeJson(stdout));
      const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
      const result = messages.findLast(isCliResult);
      if (code !== 0 || result === undefined || result.is_error === true) {
        return yield* failed(
          result?.result?.trim() || stderr.trim() || `The claude CLI exited with code ${code}.`,
        );
      }
      const answer = decodeAnswer(result.structured_output);
      if (Option.isNone(answer)) {
        return yield* failed("Claude's answer did not match its schema.");
      }
      const reason = answer.value.reason.trim();
      const repository =
        answer.value.repository === null ? null : normalizeRepository(answer.value.repository);
      if (repository === null) {
        return yield* new ClaudeCloudRepositoryChoiceError({
          reason: "not_chosen",
          detail: reason,
        });
      }
      return {
        repository,
        branch: normalizeBranch(answer.value.branch),
        reason,
      } satisfies ClaudeCloudRepositoryChoice;
    });

    const chooseRepository: ChooseClaudeCloudRepository = (request) =>
      choose(request).pipe(Effect.provideContext(context));
    return chooseRepository;
  },
);
