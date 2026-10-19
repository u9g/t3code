import type { ClaudeCloudSettings } from "@t3tools/contracts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { formatClaudeSubscriptionAuthLabel } from "../ClaudeProvider.ts";
import type { ClaudeCloudCredentialsError, ClaudeCloudLogin } from "./ClaudeCloudCredentials.ts";

const CLAUDE_CLOUD_PRESENTATION = {
  displayName: "Claude Cloud",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportsConversationRollback: false,
  // The cloud refuses bypassPermissions, and its default mode runs tools in the
  // session's sandbox without asking. The prompts it does raise reach the
  // adapter's permission callback, which full access answers itself.
  supportedRuntimeModes: ["full-access"],
} as const;

const CUSTOM_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

// A cloud session's `initialize` offers only Claude's current models, and the
// catalog marks retired ones legacy, so new releases appear without a code change.
const cloudModels = (settings: ClaudeCloudSettings, catalog: ClaudeModelCatalog) =>
  providerModelsFromSettings(
    catalog.models.map((entry) => entry.model).filter((model) => !model.isLegacy),
    settings.customModels,
    CUSTOM_MODEL_CAPABILITIES,
  );

const snapshot = (
  settings: ClaudeCloudSettings,
  catalog: ClaudeModelCatalog,
  probe: ProviderProbeResult,
) =>
  Effect.map(DateTime.now, (now) => ({
    ...buildServerProvider({
      presentation: CLAUDE_CLOUD_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: cloudModels(settings, catalog),
      slashCommands: settings.enabled ? [COMPACT_SLASH_COMMAND] : [],
      probe,
    }),
    // The driver rejects every application text-generation operation, so
    // pickers must not offer these instances for titles, commits or PR text.
    supportsTextGeneration: false,
  }));

export const makePendingClaudeCloudProvider = (
  settings: ClaudeCloudSettings,
  catalog: ClaudeModelCatalog,
) =>
  snapshot(settings, catalog, {
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Claude Cloud status has not been checked in this session yet."
      : "Claude Cloud is disabled in T3 Code settings.",
  });

const probeFromLogin = (
  login: Result.Result<ClaudeCloudLogin, ClaudeCloudCredentialsError>,
): ProviderProbeResult => {
  // Nothing runs on this machine, so there is no CLI install or version to report.
  const base = { installed: true, version: null } as const;
  if (Result.isSuccess(login)) {
    const { subscriptionType } = login.success;
    return {
      ...base,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(subscriptionType
          ? { type: subscriptionType, label: formatClaudeSubscriptionAuthLabel(subscriptionType) }
          : {}),
      },
    };
  }
  switch (login.failure.reason) {
    case "expired":
      return {
        ...base,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "The Claude login has expired. The next cloud request asks the claude CLI to refresh it; if that fails, sign in again with `claude auth login`.",
      };
    case "missing":
    case "no_sessions_scope":
      return {
        ...base,
        status: "error",
        auth: { status: "unauthenticated" },
        message: login.failure.message,
      };
    case "unreadable":
      return {
        ...base,
        status: "error",
        auth: { status: "unknown" },
        message: login.failure.message,
      };
  }
};

/**
 * Background probes only read the stored login: refreshing it or calling the
 * cloud API here would reach the network on every status refresh.
 */
export const checkClaudeCloudProviderStatus = Effect.fn("checkClaudeCloudProviderStatus")(
  function* (
    settings: ClaudeCloudSettings,
    catalog: ClaudeModelCatalog,
    readLogin: Effect.Effect<ClaudeCloudLogin, ClaudeCloudCredentialsError>,
  ) {
    if (!settings.enabled) return yield* makePendingClaudeCloudProvider(settings, catalog);
    const login = yield* Effect.result(readLogin);
    return yield* snapshot(settings, catalog, probeFromLogin(login));
  },
);
