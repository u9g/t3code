import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as CloudflareApi from "./cloudflareApi.ts";

const cloudflare = (answer: (url: URL) => { readonly status: number; readonly body: unknown }) => {
  const requests: Array<string> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      for (const [key, value] of request.urlParams) {
        url.searchParams.append(key, typeof value === "string" ? value : Redacted.value(value));
      }
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const { status, body } = answer(url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      );
    }),
  );
  return { requests, layer };
};

const clients = (layer: Layer.Layer<HttpClient.HttpClient>) =>
  CloudflareApi.layerClients({
    token: Redacted.make("token"),
    accountId: "account",
    zoneId: "zone",
  }).pipe(Layer.provide(layer));

describe("Cloudflare API clients", () => {
  it.effect("reports a missing tunnel as not found, as the provider expects", () => {
    const api = cloudflare(() => ({
      status: 404,
      body: { success: false, errors: [{ code: 1003 }], result: null },
    }));
    return Effect.gen(function* () {
      const tunnels = yield* ManagedEndpointProvider.ManagedEndpointTunnelClient;
      const error = yield* tunnels.get("tunnel-1").pipe(Effect.flip);
      expect(ManagedEndpointProvider.isManagedEndpointNotFound(error.cause)).toBe(true);
    }).pipe(Effect.provide(clients(api.layer)));
  });

  it.effect("lists tunnels with Cloudflare's filters and page info", () => {
    const api = cloudflare(() => ({
      status: 200,
      body: {
        success: true,
        result: [
          {
            id: "tunnel-1",
            name: "t3coderelay-managedendpoint-t3-0123456789abcdef",
            status: "down",
            created_at: "2026-01-01T00:00:00Z",
            conns_inactive_at: "2026-01-02T00:00:00Z",
            deleted_at: null,
          },
        ],
        result_info: { page: 2, per_page: 50, total_count: 51 },
      },
    }));
    return Effect.gen(function* () {
      const tunnels = yield* ManagedEndpointProvider.ManagedEndpointTunnelClient;
      const listed = yield* tunnels.list({
        isDeleted: false,
        includePrefix: "t3coderelay-managedendpoint-t3-",
        status: "down",
        page: 2,
        perPage: 50,
      });
      expect(api.requests).toEqual([
        "GET /client/v4/accounts/account/cfd_tunnel?is_deleted=false&include_prefix=t3coderelay-managedendpoint-t3-&status=down&page=2&per_page=50",
      ]);
      expect(listed).toEqual({
        result: [
          {
            id: "tunnel-1",
            name: "t3coderelay-managedendpoint-t3-0123456789abcdef",
            status: "down",
            createdAt: "2026-01-01T00:00:00Z",
            connsInactiveAt: "2026-01-02T00:00:00Z",
            deletedAt: null,
          },
        ],
        resultInfo: { page: 2, perPage: 50, totalCount: 51 },
      });
    }).pipe(Effect.provide(clients(api.layer)));
  });

  it.effect("keeps only DNS records whose name is exactly the hostname", () => {
    const api = cloudflare(() => ({
      status: 200,
      body: {
        success: true,
        result: [
          { id: "exact", name: "t3-0123456789abcdef.example.com" },
          { id: "other", name: "t3-0123456789abcdef.example.com.evil.test" },
        ],
      },
    }));
    return Effect.gen(function* () {
      const dns = yield* ManagedEndpointProvider.ManagedEndpointDnsClient;
      const records = yield* dns.listRecords("t3-0123456789abcdef.example.com");
      expect(records).toEqual([{ id: "exact" }]);
    }).pipe(Effect.provide(clients(api.layer)));
  });
});
