import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk/browser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as z from "zod";

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
        "A secret's value by its name from list_secret_names, as a JSON string, or null when it has none. GITHUB_TOKEN can clone and push GitHub repositories, e.g. https://x-access-token:<token>@github.com/<owner>/<name>.git, and is GH_TOKEN for the gh CLI.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const read = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
      return json(read === undefined ? null : await Effect.runPromise(read));
    },
  );
  return { type: "sdk", name: "secrets", instance: server };
};
