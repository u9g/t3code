import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { buildThreadTitlePrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { SignJWT } from "jose";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DEFAULT_INFERENCE_URL = "https://agent-gateway.livekit.cloud/v1";

// The regenerate prompt already tells the model to keep an accurate title; this makes that
// choice an explicit answer instead of something inferred from an unchanged string.
const DECISION_INSTRUCTIONS = `

Respond with JSON {"rename": boolean, "title": string} instead of the keys above.
Set rename to false and repeat the previous title when it still describes the thread.
Set rename to true only when the thread's subject has moved on enough that the previous title would mislead someone scanning a sidebar; then title is the new title.`;

const Decision = Schema.Struct({ rename: Schema.Boolean, title: Schema.String });
const decodeDecision = Schema.decodeUnknownEffect(Schema.fromJsonString(Decision));

const ChatCompletion = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});

/** A LiveKit Cloud token allowed to call LiveKit Inference, as agents' `createAccessToken` mints. */
const inferenceToken = (apiKey: string, apiSecret: string) =>
  Effect.promise(() =>
    new SignJWT({ inference: { perform: true } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(apiKey)
      .setSubject("t3code-auto-retitle")
      .setNotBefore(0)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(apiSecret)),
  );

/**
 * When a run completes, asks a LiveKit Inference model whether the thread's subject has moved
 * on from its title, and renames the thread when it has. Titles the person set are left alone.
 * A newer completed run on the same thread cancels a decision still in flight.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const renameable = (thread: {
    readonly archivedAt: unknown;
    readonly deletedAt: unknown;
    readonly titleSource?: string | undefined;
    readonly titleRegeneration?: unknown;
  }) =>
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.titleSource !== "user" &&
    // A requested regeneration owns the title until it lands.
    (thread.titleRegeneration ?? null) === null;

  const retitle = Effect.fn("AutoRetitleService.retitle")(
    function* (threadId: ThreadId, runId: RunId) {
      const current = yield* settings.getSettings;
      const config = current.autoRetitle;
      if (!config.enabled || config.apiKey === null || config.apiSecret === null) return;

      const records = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      if (!renameable(records.thread)) return;
      const context = formatThreadTitleContext(
        records.messages.filter((message) => !message.streaming),
      );
      if (context.message.length === 0) return;

      const [apiKey, apiSecret] = yield* secrets.read([config.apiKey, config.apiSecret]);
      if (!apiKey || !apiSecret) {
        return yield* Effect.logWarning("auto retitle skipped: LiveKit credentials unreadable", {
          threadId,
        });
      }

      const previousTitle = records.thread.title;
      const { prompt } = buildThreadTitlePrompt({
        message: context.message,
        attachments: context.attachments,
        previousTitle,
        instructions: current.threadTitleInstructions,
      });
      const token = yield* inferenceToken(apiKey, apiSecret);
      const response = yield* http.execute(
        HttpClientRequest.post(`${config.url || DEFAULT_INFERENCE_URL}/chat/completions`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            model: config.model,
            messages: [{ role: "user", content: prompt + DECISION_INSTRUCTIONS }],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "thread_title_decision",
                strict: true,
                schema: {
                  type: "object",
                  properties: { rename: { type: "boolean" }, title: { type: "string" } },
                  required: ["rename", "title"],
                  additionalProperties: false,
                },
              },
            },
          }),
        ),
      );
      const completion = yield* HttpClientResponse.schemaBodyJson(ChatCompletion)(response);
      const decision = yield* decodeDecision(completion.choices[0].message.content ?? "");
      const title = sanitizeThreadTitle(decision.title);
      yield* Effect.logDebug("auto retitle decision", {
        threadId,
        runId,
        rename: decision.rename,
        previousTitle,
        title,
      });
      if (!decision.rename || title === "New thread" || title === previousTitle.trim()) return;

      // The person may have renamed the thread while the model was deciding.
      const latest = yield* projections.getThread(threadId);
      if (!renameable(latest) || latest.title !== previousTitle) return;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        // One rename per completed run, even across duplicate events.
        commandId: CommandId.make(`server:auto-retitle:${threadId}:${runId}`),
        threadId,
        title,
        titleSource: "auto",
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("auto retitle skipped", { threadId, cause })),
      ),
  );

  const start = Effect.fn("AutoRetitleService.start")(function* () {
    const inFlight = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(inFlight, event.threadId, retitle(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
  });
  return { start, retitle };
});
