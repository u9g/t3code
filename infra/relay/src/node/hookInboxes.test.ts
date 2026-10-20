// @effect-diagnostics nodeBuiltinImport:off - The test stands up a real environment origin and inbox directory.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as HookInbox from "../hooks/HookInbox.ts";
import type * as HookInboxStore from "../hooks/HookInboxStore.ts";
import * as HookInboxes from "./hookInboxes.ts";

const ENDPOINT_KEY = "0123456789abcdef";

const heldHook = (id: string): HookInboxStore.HeldHook => ({
  id,
  receivedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  method: "POST",
  rawHookId: "hook-1",
  hookKey: "hook-1",
  rawToken: "token",
  query: "",
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
});

/** An environment origin that records the delivery id of each webhook it is sent. */
const environmentOrigin = Effect.gen(function* () {
  const received = yield* Deferred.make<{ readonly url: string; readonly deliveryId: string }>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        Deferred.doneUnsafe(
          received,
          Effect.succeed({
            url: request.url ?? "",
            deliveryId: String(request.headers["x-t3-relay-delivery-id"]),
          }),
        );
        response.writeHead(200).end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/`, received };
});

const inboxDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "relay-inboxes-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

const withInboxes = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(HookInboxes.layer(directory)), Effect.scoped);

describe("node hook inboxes", () => {
  it.live("delivers a held webhook once its environment wakes", () =>
    Effect.gen(function* () {
      const directory = yield* inboxDirectory;
      const origin = yield* environmentOrigin;
      yield* withInboxes(
        directory,
        Effect.gen(function* () {
          const inbox = yield* HookInbox.HookInbox;
          const stored = yield* inbox.hold({
            endpointKey: ENDPOINT_KEY,
            baseUrl: origin.baseUrl,
            hook: heldHook("delivery-1"),
          });
          expect(stored).toBe(true);
          expect(yield* inbox.wake({ endpointKey: ENDPOINT_KEY, baseUrl: origin.baseUrl })).toBe(
            true,
          );
          const delivered = yield* Deferred.await(origin.received);
          expect(delivered).toEqual({ url: "/api/hooks/hook-1/token", deliveryId: "delivery-1" });
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("delivers webhooks held before a restart", () =>
    Effect.gen(function* () {
      const directory = yield* inboxDirectory;
      const origin = yield* environmentOrigin;
      yield* withInboxes(
        directory,
        Effect.flatMap(HookInbox.HookInbox, (inbox) =>
          inbox.hold({
            endpointKey: ENDPOINT_KEY,
            baseUrl: origin.baseUrl,
            hook: heldHook("delivery-2"),
          }),
        ),
      );
      expect(Deferred.isDoneUnsafe(origin.received)).toBe(false);

      yield* withInboxes(
        directory,
        Effect.gen(function* () {
          yield* HookInbox.HookInbox;
          const delivered = yield* Deferred.await(origin.received);
          expect(delivered.deliveryId).toBe("delivery-2");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses an endpoint key that could leave the inbox directory", () =>
    Effect.gen(function* () {
      const directory = yield* inboxDirectory;
      const result = yield* withInboxes(
        directory,
        Effect.flatMap(HookInbox.HookInbox, (inbox) => inbox.clear({ endpointKey: "../escape" })),
      ).pipe(Effect.flip);
      expect(result).toBeInstanceOf(HookInbox.HookInboxError);
    }).pipe(Effect.scoped),
  );
});
