import type { ClaudeSettings } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";

const CLOUD_SESSIONS_SCOPE = "user:sessions:claude_code";
// The CLI refreshes once a token is within five minutes of expiry, so a token
// that close is about to be replaced and must not start new work.
export const CLAUDE_CLOUD_LOGIN_EXPIRY_MARGIN_MS = 5 * 60_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT = "claude-code-user";
// `security` exits with errSecItemNotFound when the login lives in the file.
const KEYCHAIN_ITEM_NOT_FOUND = 44;

const CREDENTIAL_FAILURES = {
  missing: "Claude Cloud needs a Claude login. Sign in with `claude auth login`.",
  no_sessions_scope:
    "This Claude login cannot use Claude Code cloud sessions. Sign in with a Claude subscription using `claude auth login`.",
  expired:
    "The Claude login has expired. Run `claude` once to refresh it, or sign in again with `claude auth login`.",
  unreadable: "Claude Cloud could not read the Claude login.",
} as const;

export class ClaudeCloudCredentialsError extends Schema.TaggedError<ClaudeCloudCredentialsError>()(
  "ClaudeCloudCredentialsError",
  {
    reason: Schema.Literals(
      Object.keys(CREDENTIAL_FAILURES) as Array<keyof typeof CREDENTIAL_FAILURES>,
    ),
    store: Schema.Literals(["file", "keychain"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return CREDENTIAL_FAILURES[this.reason];
  }
}

const StoredCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        accessToken: Schema.optional(Schema.NullOr(Schema.String)),
        expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
        scopes: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        subscriptionType: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeStoredCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredCredentials),
);

/** Where the `claude` CLI keeps the login that Claude Cloud borrows. */
export interface ClaudeCloudLoginLocation {
  /** `<homePath | CLAUDE_CONFIG_DIR | ~/.claude>`: holds `.credentials.json` and `settings.json`. */
  readonly configDir: string;
  /** `.claude.json`, which holds `oauthAccount.organizationUuid`. */
  readonly accountConfigPath: string;
  /** macOS Keychain service name the CLI stores the login under. */
  readonly keychainService: string;
}

/**
 * The login is read-only: the CLI owns refreshing it, and refresh tokens
 * rotate, so a second refresher would sign the CLI out.
 */
export interface ClaudeCloudLogin {
  readonly accessToken: Redacted.Redacted<string>;
  /** Epoch milliseconds; null when the store does not say. */
  readonly expiresAt: number | null;
  readonly scopes: ReadonlyArray<string>;
  readonly subscriptionType: string | null;
  readonly organizationUuid: string | null;
}

/**
 * Mirrors the CLI: with CLAUDE_CONFIG_DIR set, the Keychain item name gets
 * `-<sha256(dir)[:8]>`, hashed from the value as given. A configured `homePath`
 * reaches the CLI as CLAUDE_CONFIG_DIR (see `makeClaudeEnvironment`), so it is
 * hashed in its resolved form.
 */
export const resolveClaudeCloudLoginLocation = Effect.fn("resolveClaudeCloudLoginLocation")(
  function* (config: Pick<ClaudeSettings, "homePath">, environment: NodeJS.ProcessEnv) {
    const configDir = yield* resolveClaudeHomePath(config, environment);
    const inheritedConfigDir = environment.CLAUDE_CONFIG_DIR;
    const cliConfigDir =
      config.homePath.trim().length > 0
        ? configDir
        : inheritedConfigDir !== undefined && inheritedConfigDir.trim().length > 0
          ? inheritedConfigDir
          : undefined;
    const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
      cliConfigDir === undefined ? undefined : configDir,
    );
    const keychainService =
      cliConfigDir === undefined
        ? KEYCHAIN_SERVICE
        : `${KEYCHAIN_SERVICE}-${(yield* sha256Hex(cliConfigDir.normalize("NFC"))).slice(0, 8)}`;
    return { configDir, accountConfigPath, keychainService } satisfies ClaudeCloudLoginLocation;
  },
);

const sha256Hex = (value: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.orDie);
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

type KeychainRead =
  | { readonly _tag: "Found"; readonly json: string }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Failed"; readonly cause: unknown };

const readKeychain = (service: string) =>
  spawnAndCollect(
    "security",
    ChildProcess.make("security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      "-s",
      service,
    ]),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.map((result): KeychainRead => {
      const json = result.stdout.trim();
      if (result.code === 0 && json.length > 0) return { _tag: "Found", json };
      return result.code === 0 || result.code === KEYCHAIN_ITEM_NOT_FOUND
        ? { _tag: "Absent" }
        : { _tag: "Failed", cause: new Error(`security exited with code ${result.code}`) };
    }),
    Effect.catch((cause) => Effect.succeed<KeychainRead>({ _tag: "Failed", cause })),
  );

const readCredentialsFile = (configDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFileString(path.join(configDir, ".credentials.json")).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ClaudeCloudCredentialsError({
                  reason: "unreadable",
                  store: "file",
                  cause: error,
                }),
              ),
      }),
    );
  });

/**
 * Reads the CLI's claude.ai login on every call, so a token the CLI refreshed
 * in the meantime is picked up. On macOS the Keychain item wins and the file is
 * the fallback, as in the CLI.
 */
export const readClaudeCloudLogin = Effect.fn("readClaudeCloudLogin")(function* (
  location: ClaudeCloudLoginLocation,
) {
  let store: "file" | "keychain" = "file";
  let raw = Option.none<string>();
  let keychainFailure: unknown;
  if ((yield* HostProcess.Platform) === "darwin") {
    const keychain = yield* readKeychain(location.keychainService);
    if (keychain._tag === "Found") {
      store = "keychain";
      raw = Option.some(keychain.json);
    } else if (keychain._tag === "Failed") {
      keychainFailure = keychain.cause;
    }
  }
  if (Option.isNone(raw)) {
    raw = yield* readCredentialsFile(location.configDir);
  }
  if (Option.isNone(raw)) {
    return yield* keychainFailure === undefined
      ? new ClaudeCloudCredentialsError({ reason: "missing", store })
      : new ClaudeCloudCredentialsError({
          reason: "unreadable",
          store: "keychain",
          cause: keychainFailure,
        });
  }
  // A decode error quotes the values it rejected, here the tokens, so it is
  // not kept as a cause.
  const stored = decodeStoredCredentials(raw.value);
  if (Option.isNone(stored)) {
    return yield* new ClaudeCloudCredentialsError({ reason: "unreadable", store });
  }
  const oauth = stored.value.claudeAiOauth;
  const accessToken = oauth?.accessToken?.trim();
  if (!oauth || !accessToken) {
    return yield* new ClaudeCloudCredentialsError({ reason: "missing", store });
  }
  const scopes = oauth.scopes ?? [];
  if (!scopes.includes(CLOUD_SESSIONS_SCOPE)) {
    return yield* new ClaudeCloudCredentialsError({ reason: "no_sessions_scope", store });
  }
  const expiresAt = oauth.expiresAt ?? null;
  if (
    expiresAt !== null &&
    expiresAt - (yield* Clock.currentTimeMillis) <= CLAUDE_CLOUD_LOGIN_EXPIRY_MARGIN_MS
  ) {
    return yield* new ClaudeCloudCredentialsError({ reason: "expired", store });
  }
  const organizationUuid = yield* ClaudeResetCredits.readClaudeOrganizationId(
    location.accountConfigPath,
  );
  return {
    accessToken: Redacted.make(accessToken, { label: "claude-cloud-access-token" }),
    expiresAt,
    scopes,
    subscriptionType: oauth.subscriptionType?.trim() || null,
    organizationUuid: organizationUuid ?? null,
  } satisfies ClaudeCloudLogin;
});
