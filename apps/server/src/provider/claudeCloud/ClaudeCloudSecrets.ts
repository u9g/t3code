import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk/browser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as z from "zod";

import { GITHUB_PUSH_SCRIPT } from "./ClaudeCloudGitHubPush.ts";

/**
 * Secrets a cloud session reads by name. Each is read on this machine when a
 * session asks, so it is as fresh as its source; null when it has no value.
 */
export type ClaudeCloudSecrets = Readonly<Record<string, Effect.Effect<string | null>>>;

/** The GitHub CLI's login, with which a session clones and pushes its repository. */
const readGitHubToken = spawnAndCollect("gh", ChildProcess.make("gh", ["auth", "token"])).pipe(
  Effect.timeout("10 seconds"),
  Effect.map((result) => {
    const token = result.stdout.trim();
    return result.code === 0 && token.length > 0 ? token : null;
  }),
  Effect.orElseSucceed(() => null),
);

export const makeClaudeCloudSecrets = Effect.fn("makeClaudeCloudSecrets")(function* () {
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  return {
    GITHUB_TOKEN: readGitHubToken.pipe(Effect.provideContext(context)),
  } satisfies ClaudeCloudSecrets;
});

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * The in-process `secrets` MCP server a cloud session reads its secrets from.
 * An instance connects to one transport, so every query needs its own.
 */
export const claudeCloudSecretsServer = (
  secrets: ClaudeCloudSecrets,
): McpSdkServerConfigWithInstance => {
  const server = new McpServer({ name: "secrets", version: "1.0.0" });
  server.registerTool(
    "list_secret_names",
    {
      description: "The names of the secrets get_secret can read, as a JSON array of strings.",
    },
    async () => json(Object.keys(secrets)),
  );
  server.registerTool(
    "get_secret",
    {
      description:
        "A secret's value by its name from list_secret_names, as a JSON string, or null when it has none. GITHUB_TOKEN can clone GitHub repositories, e.g. https://x-access-token:<token>@github.com/<owner>/<name>.git, and is GH_TOKEN for the gh CLI. It cannot git push: push with github_push_script.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const read = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
      return json(read === undefined ? null : await Effect.runPromise(read));
    },
  );
  server.registerTool(
    "github_push_script",
    {
      description:
        "A Python script that pushes commits to GitHub through its REST API, for this session's git proxy refuses git push. Save it to a file and run it from the clone with GITHUB_TOKEN set: python3 <file> <owner>/<name> <branch> [--force] [--expect <sha>]. It pushes HEAD, keeps each commit's SHA, and updates the remote-tracking branch.",
    },
    async () => ({ content: [{ type: "text" as const, text: GITHUB_PUSH_SCRIPT }] }),
  );
  return { type: "sdk", name: "secrets", instance: server };
};
