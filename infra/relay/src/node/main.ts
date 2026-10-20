// @effect-diagnostics nodeBuiltinImport:off - The Node entry point owns the process, its port and its keys.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import { Agent, setGlobalDispatcher } from "undici";

import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as FcmDeliveries from "../agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueSender from "../agentActivity/FcmDeliveryQueueSender.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as HookForwarder from "../hooks/HookForwarder.ts";
import { makeHttpApp, makeLayerRuntime, pruneAndSweep } from "../runtime.ts";
import * as CloudflareApi from "./cloudflareApi.ts";
import * as HookInboxes from "./hookInboxes.ts";
import * as Migrations from "./migrations.ts";

// APNs speaks HTTP/2 only; Node's fetch negotiates it only when allowed to.
setGlobalDispatcher(new Agent({ allowH2: true }));

// Relative to the bundle, `dist/relay.mjs`, which ships beside `migrations/`.
const MIGRATIONS_DIRECTORY = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  process.env.RELAY_MIGRATIONS_DIR ?? "../migrations/postgres",
);
const DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_DELAY = "30 seconds";

const NodeRelayConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(8080)),
  publicUrl: Config.URL("RELAY_PUBLIC_URL"),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  dataDirectory: Config.String("RELAY_DATA_DIR").pipe(Config.withDefault("/data")),
  cloudflareApiToken: Config.Redacted("CLOUDFLARE_API_TOKEN"),
  cloudflareAccountId: Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID"),
  tunnelZoneName: Config.NonEmptyString("RELAY_TUNNEL_ZONE_NAME"),
  // Managed hostnames are `<namespace>-<digest>.<tunnel zone>`.
  tunnelNamespace: Config.NonEmptyString("RELAY_TUNNEL_NAMESPACE").pipe(Config.withDefault("t3")),
  cloudMintPrivateKey: Config.Redacted("RELAY_CLOUD_MINT_PRIVATE_KEY"),
  deliveryJobSigningSecret: Config.Redacted("RELAY_DELIVERY_JOB_SIGNING_SECRET"),
  clerkSecretKey: Config.Redacted("CLERK_SECRET_KEY"),
  clerkPublishableKey: Config.String("CLERK_PUBLISHABLE_KEY"),
  clerkJwtAudience: Config.String("CLERK_JWT_AUDIENCE"),
  apns: RelayConfiguration.apnsCredentialsConfig,
  fcmServiceAccount: RelayConfiguration.fcmServiceAccountConfig,
  managedEndpointCleanupMode: RelayConfiguration.managedEndpointCleanupModeConfig,
  legacyManagedEndpointCleanupMode: RelayConfiguration.legacyManagedEndpointCleanupModeConfig,
  legacyTunnelGraceMinutes: RelayConfiguration.legacyTunnelGraceMinutesConfig,
});

/** Fixed windows in memory: one relay process sees every request. */
const makeRateLimiter = (rule: { readonly limit: number; readonly periodSeconds: number }) => {
  const windows = new Map<string, { readonly start: number; count: number }>();
  const periodMs = rule.periodSeconds * 1_000;
  return (key: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (windows.size > 10_000) {
        for (const [entry, window] of windows) {
          if (now - window.start >= periodMs) windows.delete(entry);
        }
      }
      const window = windows.get(key);
      if (window === undefined || now - window.start >= periodMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      window.count += 1;
      return window.count <= rule.limit;
    });
};

/**
 * Cloudflare Queues' role here: deliver off the request, retry a failure a
 * few times, then give up. Jobs live in memory; a restart drops the few in
 * flight, which are notifications that expire in minutes anyway.
 */
const consume = <A, E, R>(
  queue: Queue.Dequeue<A>,
  process: (job: A) => Effect.Effect<unknown, E, R>,
) =>
  Queue.take(queue).pipe(
    Effect.flatMap((job) =>
      process(job).pipe(
        Effect.retry({
          times: DELIVERY_ATTEMPTS,
          schedule: Schedule.spaced(DELIVERY_RETRY_DELAY),
        }),
        Effect.catchCause((cause) => Effect.logWarning("Relay delivery job dropped", { cause })),
        Effect.forkDetach,
      ),
    ),
    Effect.forever,
  );

const program = Effect.gen(function* () {
  const config = yield* NodeRelayConfig;
  const pg = yield* Layer.build(PgClient.layer({ url: config.databaseUrl }));
  yield* Migrations.run(MIGRATIONS_DIRECTORY).pipe(Effect.provideContext(pg));
  const db = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(pg));

  const tunnelZoneId = yield* CloudflareApi.resolveZoneId({
    token: config.cloudflareApiToken,
    zoneName: config.tunnelZoneName,
  });
  const cloudMintPublicKey = NodeCrypto.createPublicKey(Redacted.value(config.cloudMintPrivateKey))
    .export({ type: "spki", format: "pem" })
    .toString();

  const apnsJobs = yield* Queue.unbounded<unknown>();
  const fcmJobs = yield* Queue.unbounded<unknown>();
  const hookRateLimit = makeRateLimiter(HookForwarder.RELAY_HOOK_RATE_LIMIT);
  const hookEndpointRateLimit = makeRateLimiter(HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT);

  const platform = Layer.mergeAll(
    RelayConfiguration.layer({
      relayIssuer: config.publicUrl.origin,
      apns: config.apns,
      ...(config.fcmServiceAccount ? { fcmServiceAccount: config.fcmServiceAccount } : {}),
      apnsDeliveryJobSigningSecret: config.deliveryJobSigningSecret,
      clerkSecretKey: config.clerkSecretKey,
      clerkPublishableKey: config.clerkPublishableKey,
      clerkJwtAudience: config.clerkJwtAudience,
      cloudMintPrivateKey: config.cloudMintPrivateKey,
      cloudMintPublicKey,
      managedEndpointBaseDomain: config.tunnelZoneName,
      managedEndpointNamespace: config.tunnelNamespace,
      managedEndpointCleanupMode: config.managedEndpointCleanupMode,
      legacyManagedEndpointCleanupMode: config.legacyManagedEndpointCleanupMode,
      ...Option.match(config.legacyTunnelGraceMinutes, {
        onNone: () => ({}),
        onSome: (legacyTunnelGraceMinutes) => ({ legacyTunnelGraceMinutes }),
      }),
    }),
    Layer.succeed(RelayDb.RelayDb, db),
    HookInboxes.layer(NodePath.join(config.dataDirectory, "hook-inboxes")),
    Layer.succeed(HookForwarder.HookRateLimiter, {
      allowHook: hookRateLimit,
      allowEndpoint: hookEndpointRateLimit,
    }),
    CloudflareApi.layerClients({
      token: config.cloudflareApiToken,
      accountId: config.cloudflareAccountId,
      zoneId: tunnelZoneId,
    }),
    Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
      send: (body) => Queue.offer(apnsJobs, body).pipe(Effect.asVoid),
    }),
    Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
      send: (body) => Queue.offer(fcmJobs, body).pipe(Effect.asVoid),
    }),
  );

  const runtime = yield* Layer.build(makeLayerRuntime(platform));

  yield* Effect.forkScoped(
    consume(apnsJobs, (job) =>
      ApnsDeliveries.ApnsDeliveries.pipe(
        Effect.flatMap((deliveries) => deliveries.processSignedJob(job)),
        Effect.withSpan("relay.apn_delivery_queue.process_message"),
      ),
    ).pipe(Effect.provideContext(runtime)),
  );
  yield* Effect.forkScoped(
    consume(fcmJobs, (job) =>
      FcmDeliveries.FcmDeliveries.pipe(Effect.flatMap((deliveries) => deliveries.process(job))),
    ).pipe(Effect.provideContext(runtime)),
  );
  yield* Effect.forkScoped(
    pruneAndSweep.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.provideContext(runtime)),
  );

  const app = yield* makeHttpApp(Layer.succeedContext(runtime));
  // Auth middleware resolves services per request, outside the app's layers.
  yield* HttpServer.serveEffect(app.pipe(Effect.provideContext(runtime)));
  yield* Effect.logInfo("Relay listening", { port: config.port, url: config.publicUrl.origin });
  return yield* Effect.never;
});

program.pipe(
  Effect.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.unwrap(
        Effect.map(NodeRelayConfig, (config) =>
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: config.port }),
        ),
      ),
    ),
  ),
  Effect.scoped,
  NodeRuntime.runMain,
);
