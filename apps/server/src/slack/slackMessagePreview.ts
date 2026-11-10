import type { SlackMessagePreview } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseSlackMessageLink, type SlackMessageLink } from "@t3tools/shared/slackMessageLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";

// Chromium records the port it was started with here; the App Store build of Slack is sandboxed.
const SLACK_PROFILE_DIRS = [
  "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
  "Library/Application Support/Slack",
];

// Runs in Slack's own page, so the API calls are same-origin and carry the session cookie; the
// client keeps each workspace's token in localStorage.
const READ_MESSAGE = `async ({ channel, ts, threadTs }) => {
  const name = (user) => user?.profile?.display_name || user?.real_name || user?.name;
  for (const team of Object.values(JSON.parse(localStorage.localConfig_v2).teams)) {
    const api = async (method, params) => {
      const response = await fetch("/api/" + method, {
        method: "POST",
        body: new URLSearchParams({ token: team.token, ...params }),
      });
      const body = await response.json();
      return body.ok ? body : null;
    };
    const at = { channel, latest: ts, oldest: ts, inclusive: "true", limit: "1" };
    const [found, info] = await Promise.all([
      threadTs && threadTs !== ts
        ? api("conversations.replies", { ...at, ts: threadTs })
        : api("conversations.history", at),
      api("conversations.info", { channel }),
    ]);
    const message = found?.messages?.find((candidate) => candidate.ts === ts);
    if (!message) continue;
    const conversation = info?.channel;
    const text = message.text || message.attachments?.[0]?.fallback || "";
    const userIds = new Set(text.match(/(?<=<@)[UW][A-Z0-9]+/g));
    if (message.user) userIds.add(message.user);
    if (conversation?.is_im) userIds.add(conversation.user);
    const users = Object.fromEntries(
      await Promise.all(
        [...userIds].map(async (user) => [user, (await api("users.info", { user }))?.user]),
      ),
    );
    return {
      conversation: conversation?.is_im
        ? name(users[conversation.user])
        : conversation?.is_mpim
          ? undefined
          : conversation?.name && "#" + conversation.name,
      author: name(users[message.user]) ?? message.bot_profile?.name ?? message.username,
      avatarUrl: users[message.user]?.profile?.image_72 ?? message.bot_profile?.icons?.image_72,
      text,
      userNames: Object.fromEntries(Object.entries(users).map(([id, user]) => [id, name(user)])),
      ts: message.ts,
      replyCount: message.reply_count ?? 0,
    };
  }
  return null;
}`;

const Targets = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    url: Schema.String,
    webSocketDebuggerUrl: Schema.optional(Schema.String),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvaluation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        result: Schema.Struct({
          value: Schema.NullOr(
            Schema.Struct({
              conversation: Schema.optional(Schema.String),
              author: Schema.optional(Schema.String),
              avatarUrl: Schema.optional(Schema.String),
              text: Schema.String,
              userNames: Schema.Record(Schema.String, Schema.String),
              ts: Schema.String,
              replyCount: Schema.Number,
            }),
          ),
        }),
      }),
    }),
  ),
);

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** Slack's message markup (`<@U1>`, `<#C1|name>`, `<url|label>`, `<!here>`) as the text it displays. */
export const slackMessageText = (text: string, userNames: Readonly<Record<string, string>>) =>
  text
    .replace(/<([^<>|]+)(?:\|([^<>]*))?>/g, (_, target: string, label: string | undefined) => {
      const id = target.slice(1);
      if (target.startsWith("@")) return `@${label || userNames[id] || id}`;
      if (target.startsWith("#")) return `#${label || id}`;
      if (target.startsWith("!")) return label || `@${id}`;
      return label || target;
    })
    .replace(/&(?:amp|lt|gt);/g, (entity) => ENTITIES[entity]!);

const evaluateInPage = Effect.fn("slack.evaluateInPage")(
  function* (webSocketDebuggerUrl: string, expression: string) {
    const socket = yield* Socket.makeWebSocket(webSocketDebuggerUrl, { openTimeout: "5 seconds" });
    const { pull } = yield* socket.reader;
    const { write } = yield* socket.writer;
    yield* write(
      encodeJson({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    const [frame] = yield* pull;
    return typeof frame === "string" ? frame : new TextDecoder().decode(frame);
  },
  Effect.scoped,
  Effect.provide(upstreamWebSocketConstructor),
);

const readSlackMessage = Effect.fn("slack.readMessage")(function* (link: SlackMessageLink) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const home = yield* HostProcess.HomeDirectory;
  const activePort = yield* Effect.firstSuccessOf(
    SLACK_PROFILE_DIRS.map((dir) =>
      fileSystem.readFileString(path.join(home, dir, "DevToolsActivePort")),
    ),
  );
  const targets = yield* httpClient
    .execute(HttpClientRequest.get(`http://127.0.0.1:${activePort.split("\n")[0]}/json`))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Targets)),
    );
  const page = targets.find(
    (target) => target.type === "page" && target.url.startsWith("https://app.slack.com/client"),
  );
  if (page?.webSocketDebuggerUrl === undefined) return null;
  const evaluation = yield* evaluateInPage(
    page.webSocketDebuggerUrl,
    `(${READ_MESSAGE})(${encodeJson(link)})`,
  ).pipe(Effect.flatMap(decodeEvaluation));
  const message = evaluation.result.result.value;
  if (message === null) return null;
  return {
    conversation: message.conversation ?? null,
    author: message.author ?? null,
    avatarUrl: message.avatarUrl ?? null,
    text: slackMessageText(message.text, message.userNames),
    postedAt: DateTime.formatIso(DateTime.makeUnsafe(Number(message.ts) * 1000)),
    replyCount: message.replyCount,
  } satisfies SlackMessagePreview;
});

/** Null when the link is not a message permalink, or Slack is not running with a debugging port. */
export const slackMessagePreview = (url: string) => {
  const link = parseSlackMessageLink(url);
  return link === null
    ? Effect.succeed(null)
    : readSlackMessage(link).pipe(
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => null),
      );
};
