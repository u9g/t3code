import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";

// The Worker's bindings behind the relay's platform services. The Node entry
// point has its own (`node/`), so nothing it imports may reach Alchemy.

export const layerManagedEndpointClients = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  Layer.mergeAll(
    ManagedEndpointProvider.layerTunnelClient({
      get: (tunnelId) =>
        tunnelClient.get(tunnelId).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      list: (request) =>
        tunnelClient.list(request).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "list",
                ...(request.name === undefined ? {} : { tunnelName: request.name }),
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      create: (request) =>
        tunnelClient.create(request).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "create",
                tunnelName: request.name,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      putConfiguration: (tunnelId, config) =>
        tunnelClient.putConfiguration(tunnelId, config).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "put-configuration",
                tunnelId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      getToken: (tunnelId) =>
        tunnelClient.getToken(tunnelId).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "get-token",
                tunnelId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      delete: (tunnelId) =>
        tunnelClient.delete(tunnelId).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "delete",
                tunnelId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
    }),
    ManagedEndpointProvider.layerDnsClient({
      listRecords: (hostname) =>
        dnsClient.listDnsRecords({ search: hostname }).pipe(
          Effect.timeout("8 seconds"),
          Effect.map((response) =>
            response.result.filter(
              (record): record is typeof record & { readonly id: string } =>
                typeof record.id === "string" &&
                ManagedEndpointProvider.normalizeHostname(record.name) ===
                  ManagedEndpointProvider.normalizeHostname(hostname),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointDnsClientError({
                operation: "list-records",
                hostname,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      createRecord: (request) =>
        dnsClient.createDnsRecord(request).pipe(
          Effect.timeout("8 seconds"),
          Effect.map((response) => ({ id: response.id })),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointDnsClientError({
                operation: "create-record",
                hostname: request.name,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      updateRecord: (dnsRecordId, request) =>
        dnsClient.updateDnsRecord(dnsRecordId, request).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointDnsClientError({
                operation: "update-record",
                hostname: request.name,
                dnsRecordId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      deleteRecord: (dnsRecordId) =>
        dnsClient.deleteDnsRecord(dnsRecordId).pipe(
          Effect.timeout("8 seconds"),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvider.ManagedEndpointDnsClientError({
                operation: "delete-record",
                dnsRecordId,
                cause,
              }),
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
    }),
  );

export const layerApnsDeliveryQueueSender = (
  sender: Cloudflare.Queues.WriteQueueClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  Layer.succeed(
    ApnsDeliveryQueue.ApnsDeliveryQueueSender,
    ApnsDeliveryQueue.ApnsDeliveryQueueSender.of({
      send: (body) =>
        sender
          .send(body)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
    }),
  );
