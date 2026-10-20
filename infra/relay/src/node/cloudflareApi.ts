import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT = "8 seconds";

/** Carries the HTTP status, which the provider and reaper read for 404 and 429. */
export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
    errors: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Cloudflare API ${this.method} ${this.path} answered ${this.status}`;
  }
}

const ResultInfo = Schema.NullOr(
  Schema.Struct({
    page: Schema.optional(Schema.NullOr(Schema.Number)),
    per_page: Schema.optional(Schema.NullOr(Schema.Number)),
    total_count: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Unknown),
  result: Schema.Unknown,
  result_info: Schema.optional(ResultInfo),
});

const ApiTunnel = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  conns_inactive_at: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
});
type ApiTunnel = typeof ApiTunnel.Type;

const WithId = Schema.Struct({ id: Schema.String });
const DnsRecord = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeTunnel = Schema.decodeUnknownEffect(ApiTunnel);
const decodeTunnels = Schema.decodeUnknownEffect(Schema.Array(ApiTunnel));
const decodeWithId = Schema.decodeUnknownEffect(WithId);
const decodeZones = Schema.decodeUnknownEffect(Schema.Array(WithId));
const decodeDnsRecords = Schema.decodeUnknownEffect(Schema.Array(DnsRecord));
const decodeToken = Schema.decodeUnknownEffect(Schema.String);
const ignoreResult = (result: unknown) => Effect.succeed(result);

const toTunnel = (tunnel: ApiTunnel): ManagedEndpointProvider.ManagedEndpointTunnel => ({
  id: tunnel.id ?? null,
  name: tunnel.name ?? null,
  status: tunnel.status ?? null,
  createdAt: tunnel.created_at ?? null,
  connsInactiveAt: tunnel.conns_inactive_at ?? null,
  deletedAt: tunnel.deleted_at ?? null,
});

const makeApi = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(token))),
  );
  return <A, E>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    decodeResult: (result: unknown) => Effect.Effect<A, E>,
    options: {
      readonly query?: Record<string, string | number | boolean | undefined>;
      readonly body?: unknown;
    } = {},
  ) =>
    Effect.gen(function* () {
      const query = Object.entries(options.query ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, String(value)] as const],
      );
      let request = HttpClientRequest.make(method)(`${API_BASE}${path}`).pipe(
        HttpClientRequest.setUrlParams(query),
      );
      if (options.body !== undefined) {
        request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
      }
      const response = yield* client.execute(request);
      const envelope = yield* decodeEnvelope(yield* response.json);
      if (response.status < 200 || response.status >= 300 || !envelope.success) {
        return yield* new CloudflareApiError({
          method,
          path,
          status: response.status,
          errors: envelope.errors ?? null,
        });
      }
      return {
        result: yield* decodeResult(envelope.result),
        resultInfo: envelope.result_info ?? null,
      };
    }).pipe(Effect.timeout(REQUEST_TIMEOUT));
});

/** Finds a zone's id by name, so the relay is configured with names alone. */
export const resolveZoneId = Effect.fn("relay.cloudflare.resolve_zone_id")(function* (input: {
  readonly token: Redacted.Redacted<string>;
  readonly zoneName: string;
}) {
  const api = yield* makeApi(input.token);
  const zones = yield* api("GET", "/zones", decodeZones, {
    query: { name: input.zoneName },
  });
  const zone = zones.result[0];
  if (!zone) {
    return yield* Effect.die(
      new Error(`Cloudflare zone '${input.zoneName}' is not visible to the API token`),
    );
  }
  return zone.id;
});

export const layerClients = (input: {
  readonly token: Redacted.Redacted<string>;
  readonly accountId: string;
  readonly zoneId: string;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const api = yield* makeApi(input.token);
      const tunnels = `/accounts/${input.accountId}/cfd_tunnel`;
      const records = `/zones/${input.zoneId}/dns_records`;
      const tunnelError =
        (
          operation: ManagedEndpointProvider.ManagedEndpointTunnelClientError["operation"],
          target: {
            readonly tunnelId?: string;
            readonly tunnelName?: string;
          },
        ) =>
        (cause: unknown) =>
          new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
            operation,
            ...target,
            cause,
          });
      const dnsError =
        (
          operation: ManagedEndpointProvider.ManagedEndpointDnsClientError["operation"],
          target: {
            readonly hostname?: string;
            readonly dnsRecordId?: string;
          },
        ) =>
        (cause: unknown) =>
          new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation,
            ...target,
            cause,
          });

      return Layer.mergeAll(
        ManagedEndpointProvider.layerTunnelClient({
          get: (tunnelId) =>
            api("GET", `${tunnels}/${tunnelId}`, decodeTunnel).pipe(
              Effect.map((response) => toTunnel(response.result)),
              Effect.mapError(tunnelError("get", { tunnelId })),
            ),
          list: (request) =>
            api("GET", tunnels, decodeTunnels, {
              query: {
                is_deleted: request.isDeleted,
                name: request.name,
                include_prefix: request.includePrefix,
                status: request.status,
                existed_at: request.existedAt,
                was_inactive_at: request.wasInactiveAt,
                page: request.page,
                per_page: request.perPage,
              },
            }).pipe(
              Effect.map((response) => ({
                result: response.result.map(toTunnel),
                resultInfo: response.resultInfo
                  ? {
                      page: response.resultInfo.page ?? null,
                      perPage: response.resultInfo.per_page ?? null,
                      totalCount: response.resultInfo.total_count ?? null,
                    }
                  : null,
              })),
              Effect.mapError(
                tunnelError("list", request.name === undefined ? {} : { tunnelName: request.name }),
              ),
            ),
          create: (request) =>
            api("POST", tunnels, decodeTunnel, {
              body: { name: request.name, config_src: request.configSrc },
            }).pipe(
              Effect.map((response) => toTunnel(response.result)),
              Effect.mapError(tunnelError("create", { tunnelName: request.name })),
            ),
          putConfiguration: (tunnelId, config) =>
            api("PUT", `${tunnels}/${tunnelId}/configurations`, ignoreResult, {
              body: { config },
            }).pipe(Effect.mapError(tunnelError("put-configuration", { tunnelId }))),
          getToken: (tunnelId) =>
            api("GET", `${tunnels}/${tunnelId}/token`, decodeToken).pipe(
              Effect.map((response) => response.result),
              Effect.mapError(tunnelError("get-token", { tunnelId })),
            ),
          delete: (tunnelId) =>
            api("DELETE", `${tunnels}/${tunnelId}`, ignoreResult).pipe(
              Effect.mapError(tunnelError("delete", { tunnelId })),
            ),
        }),
        ManagedEndpointProvider.layerDnsClient({
          listRecords: (hostname) =>
            api("GET", records, decodeDnsRecords, {
              query: { name: hostname },
            }).pipe(
              Effect.map((response) =>
                response.result.flatMap((record) =>
                  typeof record.id === "string" &&
                  record.name !== undefined &&
                  ManagedEndpointProvider.normalizeHostname(record.name) ===
                    ManagedEndpointProvider.normalizeHostname(hostname)
                    ? [{ id: record.id }]
                    : [],
                ),
              ),
              Effect.mapError(dnsError("list-records", { hostname })),
            ),
          createRecord: (request) =>
            api("POST", records, decodeWithId, { body: request }).pipe(
              Effect.map((response) => ({ id: response.result.id })),
              Effect.mapError(dnsError("create-record", { hostname: request.name })),
            ),
          updateRecord: (dnsRecordId, request) =>
            api("PUT", `${records}/${dnsRecordId}`, ignoreResult, { body: request }).pipe(
              Effect.mapError(dnsError("update-record", { hostname: request.name, dnsRecordId })),
            ),
          deleteRecord: (dnsRecordId) =>
            api("DELETE", `${records}/${dnsRecordId}`, ignoreResult).pipe(
              Effect.mapError(dnsError("delete-record", { dnsRecordId })),
            ),
        }),
      );
    }),
  );
