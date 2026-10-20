import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import * as RelayHttpApi from "./http/Api.ts";
import * as Observability from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";

// The relay runs on Cloudflare Workers (`worker.ts`) and as a Node service
// (`node.ts`). Everything here is shared; each entry point supplies only what
// its platform provides: configuration, the database, queues, the hook inbox,
// tunnel and DNS clients, and rate limiting.

const layerWebcrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const layerHttpPlatformNotSupported = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const layerRelayApi = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
);

export const makeLayerRuntime = <ROut, E, RIn>(platform: Layer.Layer<ROut, E, RIn>) =>
  Layer.empty.pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentPublishSignatures.layer,
        ManagedEndpointReaper.layer,
        HeldHooks.layer,
      ),
    ),
    Layer.provideMerge(ManagedEndpointProvider.layer),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(ApnsDeliveries.layer),
    Layer.provideMerge(
      FcmDeliveries.layer.pipe(
        Layer.provideMerge(
          FcmClient.layer.pipe(
            Layer.provide(FcmAssertionSigner.layer),
            Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
    Layer.provideMerge(ApnsDeliveryQueue.layer),
    Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer)),
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentLinks.layer,
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
      ),
    ),
    Layer.provideMerge(LiveActivities.layer),
    Layer.provideMerge(DeliveryAttempts.layer),
    Layer.provideMerge(RelayTokens.layer),
    Layer.provideMerge(RelayDb.RelayTransactions.layer),
    Layer.provideMerge(platform),
    Layer.provideMerge(layerWebcrypto),
  );

export const makeHttpApp = <ROut, E, RIn>(layerRuntime: Layer.Layer<ROut, E, RIn>) => {
  const layerApp = Layer.merge(
    layerRelayApi,
    HookForwarder.layerApi.pipe(Layer.provide(HookForwarder.layer)),
  ).pipe(
    Layer.provideMerge(RelayHttpApi.layerClientAuth),
    Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
    Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
    Layer.provide(layerRuntime),
  );

  return Layer.merge(
    Layer.mergeAll(
      HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(layerApp),
      ),
      HttpApiScalar.layer(RelayApi, { path: "/docs" }),
      RelayHttpApi.layerDocsRedirectRoute,
    ).pipe(Layer.provide([Etag.layerWeak, layerHttpPlatformNotSupported, RelayHttpApi.layerCors])),
    RelayHttpApi.layerNotFoundRoute,
  ).pipe(
    HttpRouter.toHttpEffect,
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    withoutCapturedParentSpan,
    Effect.map((httpEffect) =>
      traceRelayHttpRequestWith(httpEffect, Layer.empty).pipe(
        Observability.withSchemaErrorSpanAttributes,
      ),
    ),
  );
};

/** Runs every five minutes on both platforms. */
export const pruneAndSweep = Effect.all(
  [
    DpopProofs.DpopProofReplay.pipe(
      Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
      Effect.andThen(
        Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
          Effect.flatMap(([activityRows, now]) =>
            activityRows.pruneTerminal({
              updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to prune expired relay state", { cause }),
      ),
    ),
    ManagedEndpointReaper.ManagedEndpointReaper.pipe(
      Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
      Effect.tap((result) =>
        result.scanned > 0
          ? Effect.logInfo("Finished managed tunnel cleanup", result)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
      ),
    ),
  ],
  { concurrency: 2, discard: true },
).pipe(
  Effect.withSpan("relay.cron.prune_expired_state"),
  Observability.withSchemaErrorSpanAttributes,
);
