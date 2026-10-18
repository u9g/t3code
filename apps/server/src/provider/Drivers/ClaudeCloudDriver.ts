import {
  ClaudeCloudSettings,
  ClaudeSettings,
  type OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import {
  ClaudeProviderCapabilitiesV2,
  makeClaudeAdapterV2,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeCloudQueryRunner } from "../../orchestration-v2/Adapters/ClaudeCloudQueryRunner.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ClaudeCloudApi from "../claudeCloud/ClaudeCloudApi.ts";
import * as ClaudeCloudCredentials from "../claudeCloud/ClaudeCloudCredentials.ts";
import { claudeCloudFilesDir } from "../claudeCloud/ClaudeCloudFiles.ts";
import { makeRefreshingClaudeCloudLogin } from "../claudeCloud/ClaudeCloudLoginRefresh.ts";
import {
  makeClaudeCloudRepositoryChooser,
  normalizeRepository,
} from "../claudeCloud/ClaudeCloudRepositoryChoice.ts";
import {
  checkClaudeCloudProviderStatus,
  makePendingClaudeCloudProvider,
} from "../claudeCloud/ClaudeCloudStatus.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeCloud");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const decodeClaudeCloudSettings = Schema.decodeSync(ClaudeCloudSettings);
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
// The `claude` binary belongs to the Claude driver; this one only borrows its login.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/**
 * A cloud session keeps its transcript and checkout in Anthropic's cloud, so
 * nothing here can rewind or fork it. T3's MCP server on this machine is out of
 * its reach, but its tools reach the session through an in-process relay.
 */
export const ClaudeCloudCapabilitiesV2 = {
  ...ClaudeProviderCapabilitiesV2,
  threads: {
    ...ClaudeProviderCapabilitiesV2.threads,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
  },
  tools: {
    ...ClaudeProviderCapabilitiesV2.tools,
    supportsDynamicToolCallbacks: false,
  },
  checkpointing: {
    ...ClaudeProviderCapabilitiesV2.checkpointing,
    appCanCheckpointFilesystem: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Claude Cloud instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type ClaudeCloudDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
  | ServerConfig.ServerConfig;

export const ClaudeCloudDriver: ProviderDriver<ClaudeCloudSettings, ClaudeCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Cloud",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeCloudSettings,
  defaultConfig: (): ClaudeCloudSettings => decodeClaudeCloudSettings({}),
  create: Effect.fn("ClaudeCloudDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const services = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const { attachmentsDir, baseDir } = yield* ServerConfig.ServerConfig;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    // Cloud sessions run Claude's own models, so the Claude catalog describes them.
    const modelCatalog = catalogService
      .current(CLAUDE_DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));

    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies ClaudeCloudSettings;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const claudeEnvironment = yield* makeClaudeEnvironment(effectiveConfig, processEnvironment);
    const loginLocation = yield* ClaudeCloudCredentials.resolveClaudeCloudLoginLocation(
      effectiveConfig,
      processEnvironment,
    );
    const readLogin = ClaudeCloudCredentials.readClaudeCloudLogin(loginLocation).pipe(
      Effect.provideContext(services),
    );
    const login = yield* makeRefreshingClaudeCloudLogin({
      location: loginLocation,
      binaryPath: effectiveConfig.binaryPath,
      environment: claudeEnvironment,
    });
    const api = yield* ClaudeCloudApi.make({ login, version: packageJson.version });
    const chooseRepository = yield* makeClaudeCloudRepositoryChooser({
      binaryPath: effectiveConfig.binaryPath,
      environment: claudeEnvironment,
    });
    const fallbackRepository =
      effectiveConfig.fallbackRepository === ""
        ? null
        : normalizeRepository(effectiveConfig.fallbackRepository);
    if (fallbackRepository === null && effectiveConfig.fallbackRepository !== "") {
      yield* Effect.logWarning(
        "Claude Cloud ignores its fallback repository setting, which is not a GitHub owner/name.",
      );
    }

    const queryRunner = yield* makeClaudeCloudQueryRunner({
      api,
      environmentId: effectiveConfig.environmentId || undefined,
      configDir: loginLocation.configDir,
      filesDir: yield* claudeCloudFilesDir,
      // Where ManagedProjectFolders makes the folders of "No project" threads.
      withoutProject: {
        scratchRoot: path.resolve(baseDir, "scratch"),
        chooseRepository,
        fallbackRepository: fallbackRepository ?? undefined,
      },
    }).pipe(Effect.provide(VcsProcess.layer));

    // The adapter reads Claude settings; only the custom models and the
    // config dir (for `$skill` lookups) mean anything for a cloud session.
    const adapterSettings = {
      ...DEFAULT_CLAUDE_SETTINGS,
      enabled,
      binaryPath: effectiveConfig.binaryPath,
      homePath: effectiveConfig.homePath,
      customModels: effectiveConfig.customModels,
    } satisfies ClaudeSettings;
    const orchestrationAdapter = yield* makeClaudeAdapterV2({
      instanceId,
      settings: adapterSettings,
      environment: claudeEnvironment,
      attachmentsDir,
      fileSystem,
      path,
      crypto,
      idAllocator,
      queryRunner,
      continuationRequests,
      driverKind: DRIVER_KIND,
      capabilities: ClaudeCloudCapabilitiesV2,
      transport: "remote",
    });

    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<ClaudeCloudSettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) => makePendingClaudeCloudProvider(settings.provider, catalog)),
          Effect.map(stampIdentity),
        ),
      checkProvider: modelCatalog.pipe(
        Effect.flatMap((catalog) =>
          checkClaudeCloudProviderStatus(effectiveConfig, catalog, readLogin),
        ),
        Effect.map(stampIdentity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Claude Cloud snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      // Cloud sessions live in Anthropic's cloud, so a local Claude instance
      // cannot resume them even when both use the same login.
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
