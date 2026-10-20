import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpMiddleware from "effect/http/HttpMiddleware";

import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { RelayObservability } from "./observabilityResources.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as FcmDeliveryQueueConsumer from "./agentActivity/FcmDeliveryQueueConsumer.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as RelayConfiguration from "./Config.ts";
import * as CloudflareBindings from "./cloudflareBindings.ts";
import * as RelayDatabase from "./database.ts";
import * as RelayDb from "./db.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookInboxObject from "./hooks/HookInboxObject.ts";
import {
  RelayApnsDeliveryDeadLetterQueue,
  RelayApnsDeliveryQueue,
  RelayFcmDeliveryQueue,
  RelayFcmDeliveryDeadLetterQueue,
} from "./queues.ts";
import { makeHttpApp, makeLayerRuntime, pruneAndSweep } from "./runtime.ts";

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const layer = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const fcmDeliveryQueue = yield* RelayFcmDeliveryQueue;
    const fcmDeliveryDeadLetterQueue = yield* RelayFcmDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    yield* RelayObservability;

    const apnsCredentials = yield* RelayConfiguration.apnsCredentialsConfig;
    const fcmServiceAccount = yield* RelayConfiguration.fcmServiceAccountConfig;
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);
    const fcmDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(fcmDeliveryQueue);

    const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.String("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.String("CLERK_JWT_AUDIENCE");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDatabase.RelayHyperdrive);
    // Named prepared statements collide behind Hyperdrive's transaction-mode
    // pool: sql-pg < 4.0.0-rc.117 names them `effect1..N` per connection, and
    // inside a transaction a Bind can reach another request's statement
    // (#14070, Effect-TS/effect#8320). Unnamed statements cannot collide.
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString, undefined, {
      prepare: false,
    });

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;
    const managedEndpointCleanupMode = yield* RelayConfiguration.managedEndpointCleanupModeConfig;
    const legacyManagedEndpointCleanupMode =
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig;
    const legacyTunnelGraceMinutes = Option.getOrUndefined(
      yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
    );
    // Keys are endpoint keys or hashes over them, which already differ per
    // stage, so stages sharing an account cannot collide in these namespaces.
    const hookRateLimit = yield* Cloudflare.RateLimit("HOOK_RATE_LIMIT", {
      namespaceId: 1001,
      simple: {
        limit: HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
      },
    });
    const hookEndpointRateLimit = yield* Cloudflare.RateLimit("HOOK_ENDPOINT_RATE_LIMIT", {
      namespaceId: 1002,
      simple: {
        limit: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      },
    });
    const hookInboxes = yield* HookInboxObject.HookInboxObject;

    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        ...(fcmServiceAccount ? { fcmServiceAccount } : {}),
        apns: apnsCredentials,
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
        managedEndpointCleanupMode,
        legacyManagedEndpointCleanupMode,
        ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
      });
    });

    const inboxCall =
      <A>(operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
      (effect: Effect.Effect<A, never, Alchemy.RuntimeContext>) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catchCause((cause) =>
            Effect.fail(
              new HookInbox.HookInboxError({
                operation,
                endpointKey,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );
    const layerHookInbox = Layer.succeed(HookInbox.HookInbox, {
      hold: ({ endpointKey, baseUrl, hook }) =>
        hookInboxes.getByName(endpointKey).hold(hook, baseUrl).pipe(inboxCall("hold", endpointKey)),
      wake: ({ endpointKey, baseUrl }) =>
        hookInboxes.getByName(endpointKey).wake(baseUrl).pipe(inboxCall("wake", endpointKey)),
      clear: ({ endpointKey }) =>
        hookInboxes.getByName(endpointKey).clear().pipe(inboxCall("clear", endpointKey)),
    });

    // Fails open: a limiter outage must not drop webhooks the environment would accept.
    const allowWith =
      (limiter: typeof hookRateLimit) =>
      (key: string): Effect.Effect<boolean> =>
        limiter.limit({ key }).pipe(
          Effect.map((result) => result.success),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catch((error) =>
            Effect.logWarning("Hook rate limiter unavailable", { error: error.message }).pipe(
              Effect.andThen(
                Effect.annotateCurrentSpan({ "relay.hook.rate_limiter_failed_open": true }),
              ),
              Effect.as(true),
            ),
          ),
        );
    const layerHookRateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
      allowHook: allowWith(hookRateLimit),
      allowEndpoint: allowWith(hookEndpointRateLimit),
    });

    const layerRuntime = makeLayerRuntime(
      Layer.mergeAll(
        Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings),
        Layer.succeed(RelayDb.RelayDb, db),
        layerHookInbox,
        layerHookRateLimiter,
        CloudflareBindings.layerManagedEndpointClients(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
        CloudflareBindings.layerApnsDeliveryQueueSender(
          apnsDeliveryQueueSender,
          alchemyRuntimeContext,
        ),
        Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
          send: (body) =>
            fcmDeliveryQueueSender
              .send(body)
              .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
        }),
      ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      fcmDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "1 second",
        retryDelay: "30 seconds",
        deadLetterQueue: fcmDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.fcm_delivery_queue.process_batch"),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      pruneAndSweep.pipe(Effect.provide(layerRuntime)),
    );

    const fetch = makeHttpApp(layerRuntime);

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
        Layer.provideMerge(Cloudflare.Workers.RateLimitBinding),
        Layer.provideMerge(HookInboxObject.layer),
        // The worker runtime opens its own HTTP span around ours. Ours carries
        // the route, header redaction and webhook URL redaction, and drops a
        // webhook sender's traceparent, so the runtime's span is off for every
        // request rather than duplicating it.
        Layer.provideMerge(
          Alchemy.Telemetry.layer(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
        ),
        Layer.provideMerge(
          Layer.unwrap(
            Effect.map(RelayObservability, (observability) =>
              Axiom.Telemetry({
                serviceName: "t3code-relay",
                token: observability.workerIngestToken,
                traces: observability.traces,
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);

export default layer;
