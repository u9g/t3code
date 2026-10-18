import { describe, expect, it } from "@effect/vitest";
import { ClaudeCloudSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { BUNDLED_CLAUDE_MODEL_CATALOG, type ClaudeCatalogModel } from "../ClaudeModelCatalog.ts";
import { ClaudeCloudCredentialsError, type ClaudeCloudLogin } from "./ClaudeCloudCredentials.ts";
import {
  checkClaudeCloudProviderStatus,
  makePendingClaudeCloudProvider,
} from "./ClaudeCloudStatus.ts";

const decodeSettings = Schema.decodeSync(ClaudeCloudSettings);
const enabled = decodeSettings({ enabled: true });

const login = {
  accessToken: Redacted.make("sk-ant-oat-test"),
  expiresAt: null,
  scopes: ["user:sessions:claude_code"],
  subscriptionType: "max",
  organizationUuid: "org-1",
} satisfies ClaudeCloudLogin;

const check = (
  settings: ClaudeCloudSettings,
  readLogin: Effect.Effect<ClaudeCloudLogin, ClaudeCloudCredentialsError>,
) => checkClaudeCloudProviderStatus(settings, BUNDLED_CLAUDE_MODEL_CATALOG, readLogin);

const failedRead = (reason: ClaudeCloudCredentialsError["reason"]) =>
  Effect.fail(new ClaudeCloudCredentialsError({ reason, store: "file" }));

describe("checkClaudeCloudProviderStatus", () => {
  it.effect("reports a usable login as ready, labelled with its subscription", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(enabled, Effect.succeed(login));
      expect(snapshot).toMatchObject({
        displayName: "Claude Cloud",
        status: "ready",
        installed: true,
        version: null,
        auth: { status: "authenticated", type: "max", label: "Claude Max Subscription" },
        supportsConversationRollback: false,
        showInteractionModeToggle: true,
        reportsContextWindow: true,
        supportedRuntimeModes: ["full-access"],
      });
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("offers the Claude models a cloud session can run, plus custom models", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(
        decodeSettings({ enabled: true, customModels: ["claude-custom"] }),
        Effect.succeed(login),
      );
      expect(snapshot.models.map((model) => model.slug).toSorted()).toEqual([
        "claude-custom",
        "claude-fable-5-1",
        "claude-haiku-5-5",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
      ]);
      const opus = snapshot.models.find((model) => model.slug === "claude-opus-5-5");
      const catalogOpus = BUNDLED_CLAUDE_MODEL_CATALOG.models.find(
        (entry) => entry.model.slug === "claude-opus-5-5",
      )?.model;
      expect(opus?.capabilities).toEqual(catalogOpus?.capabilities);
    }),
  );

  it.effect("offers a newly released Claude model and drops one the catalog retires", () =>
    Effect.gen(function* () {
      const released = {
        model: {
          slug: "claude-opus-6",
          name: "Claude Opus 6",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        runtime: {},
        compatibility: {},
      } satisfies ClaudeCatalogModel;
      const catalog = {
        models: [
          released,
          ...BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) =>
            entry.model.slug === "claude-haiku-5-5"
              ? { ...entry, model: { ...entry.model, isLegacy: true } }
              : entry,
          ),
        ],
      };
      const snapshot = yield* checkClaudeCloudProviderStatus(
        enabled,
        catalog,
        Effect.succeed(login),
      );
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("claude-opus-6");
      expect(slugs).not.toContain("claude-haiku-5-5");
    }),
  );

  it.effect("never offers itself for text generation, before or after its status check", () =>
    Effect.gen(function* () {
      const snapshots = [
        yield* makePendingClaudeCloudProvider(enabled, BUNDLED_CLAUDE_MODEL_CATALOG),
        yield* check(enabled, Effect.succeed(login)),
        yield* check(enabled, failedRead("missing")),
        yield* check(decodeSettings({}), Effect.succeed(login)),
      ];
      for (const snapshot of snapshots) {
        expect(snapshot.supportsTextGeneration).toBe(false);
      }
    }),
  );

  it.effect("asks for a sign-in when there is no usable login", () =>
    Effect.gen(function* () {
      for (const reason of ["missing", "no_sessions_scope"] as const) {
        const snapshot = yield* check(enabled, failedRead(reason));
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("claude auth login");
      }
    }),
  );

  it.effect("only warns about an expired login, which the next request refreshes", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(enabled, failedRead("expired"));
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("refresh");
    }),
  );

  it.effect("does not read the login while disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(
        decodeSettings({}),
        Effect.die("a disabled instance must not read the login"),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toBe("Claude Cloud is disabled in T3 Code settings.");
    }),
  );
});
