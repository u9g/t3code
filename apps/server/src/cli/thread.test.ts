import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ThreadTools, threadMcpServersFromConfig, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  const toolTakesParameter = () => Effect.die("unscripted tools/list call");
  return { tools: { call, toolTakesParameter } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

const mcpConfigError = (config: unknown) =>
  threadMcpServersFromConfig(typeof config === "string" ? config : JSON.stringify(config)).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

it.effect("--mcp-config takes Claude Code's mcpServers shape for HTTP servers", () =>
  Effect.gen(function* () {
    const servers = yield* threadMcpServersFromConfig(
      JSON.stringify({
        mcpServers: {
          gem: {
            type: "http",
            url: "http://127.0.0.1:7341/mcp/thread/1",
            headers: { Authorization: "Bearer gem-token" },
            // Fields Claude Code knows and a thread does not, such as a timeout, are left out.
            timeout: 5_000,
          },
          docs: { type: "http", url: "https://docs.example/mcp" },
        },
      }),
    );

    assert.deepStrictEqual(servers, {
      gem: {
        type: "http",
        url: "http://127.0.0.1:7341/mcp/thread/1",
        headers: { Authorization: "Bearer gem-token" },
      },
      docs: { type: "http", url: "https://docs.example/mcp" },
    });
  }),
);

it.effect("--mcp-config rejects what a thread cannot use, without quoting headers", () =>
  Effect.gen(function* () {
    const headers = { Authorization: "Bearer must-not-leak" };
    const messages = [
      yield* mcpConfigError("{not json"),
      yield* mcpConfigError({ servers: {} }),
      yield* mcpConfigError({ mcpServers: {} }),
      yield* mcpConfigError({
        mcpServers: { "t3-code": { type: "http", url: "http://x/mcp", headers } },
      }),
      yield* mcpConfigError({ mcpServers: { "gem server": { type: "http", url: "http://x" } } }),
      yield* mcpConfigError({ mcpServers: { gem: { command: "gem", args: ["mcp"] } } }),
      yield* mcpConfigError({ mcpServers: { gem: { type: "sse", url: "http://x", headers } } }),
      yield* mcpConfigError({ mcpServers: { gem: { type: "http", url: "file:///mcp", headers } } }),
      yield* mcpConfigError({
        mcpServers: { gem: { type: "http", url: "http://x", headers: { Authorization: 1 } } },
      }),
    ];

    assert.deepStrictEqual(messages, [
      "--mcp-config: not valid JSON, or a file that holds it.",
      '--mcp-config: needs an "mcpServers" object.',
      '--mcp-config: "mcpServers" is empty.',
      "--mcp-config: t3-code is T3 Code's own MCP server; give yours another name.",
      "--mcp-config: server name 'gem server' must be 1 to 64 letters, digits, '_' or '-', since Claude puts it in tool names.",
      '--mcp-config: server \'gem\' has type "stdio"; only "http" servers are supported, since the agent may run on another machine.',
      '--mcp-config: server \'gem\' has type "sse"; only "http" servers are supported, since the agent may run on another machine.',
      "--mcp-config: server 'gem' needs a \"url\" starting with http:// or https://.",
      "--mcp-config: server 'gem' has \"headers\" that are not all strings.",
    ]);
    assert.notInclude(messages.join("\n"), "must-not-leak");
  }),
);
