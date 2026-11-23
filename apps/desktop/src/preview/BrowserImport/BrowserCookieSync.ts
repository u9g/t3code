import { BrowserImportSourceId, BrowserProfileId } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Cookie } from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { cookieScope, type ImportedCookie } from "./CookieDatabase.ts";

/** A browser profile whose cookies keep flowing into a T3 Code profile after it was imported. */
const CookieSyncBinding = Schema.Struct({
  environmentId: Schema.String,
  targetProfileId: BrowserProfileId,
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: Schema.String,
  // The target's partition, as the import resolved it.
  scope: Schema.String,
  persistent: Schema.Boolean,
  namespace: Schema.optionalKey(Schema.Literal("profile")),
});
export type CookieSyncBinding = typeof CookieSyncBinding.Type;

const CookieSyncsJson = fromLenientJson(Schema.Array(CookieSyncBinding));
const decodeCookieSyncs = Schema.decodeEffect(CookieSyncsJson);
const encodeCookieSyncs = Schema.encodeEffect(CookieSyncsJson);

// The source browser writes its database in bursts; sync once the burst is over.
const SETTLE = Duration.seconds(2);
// Catches a change the file watch missed.
const FALLBACK_INTERVAL = Duration.minutes(10);
// Between attempts while the source cannot be read or watched (a running Firefox, a missing profile).
const RETRY_INTERVAL = Duration.minutes(1);

const cookieKey = (domain: string, name: string, path: string) =>
  JSON.stringify([domain, name, path]);

const importedKey = (cookie: ImportedCookie) =>
  cookieKey(cookie.domain ?? new URL(cookie.url).hostname, cookie.name, cookie.path);

const currentKey = (cookie: Cookie) =>
  cookieKey(cookie.domain ?? "", cookie.name, cookie.path ?? "");

const wholeSeconds = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.floor(seconds);

/**
 * What to change so the target matches the source: write the source's cookies the target lacks or
 * holds differently, and remove the ones the source dropped since the last sync (`previous`).
 * Cookies only the target ever had stay.
 */
export function planCookieSync(
  source: ReadonlyArray<ImportedCookie>,
  current: ReadonlyArray<Cookie>,
  previous: ReadonlySet<string>,
  nowSeconds: number,
): {
  readonly set: ReadonlyArray<ImportedCookie>;
  readonly remove: ReadonlyArray<{ readonly url: string; readonly name: string }>;
  readonly keys: ReadonlySet<string>;
} {
  const live = source.filter(
    (cookie) => cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds,
  );
  const currentByKey = new Map(current.map((cookie) => [currentKey(cookie), cookie]));
  const keys = new Set(live.map(importedKey));
  const set = live.filter((cookie) => {
    const existing = currentByKey.get(importedKey(cookie));
    return (
      existing === undefined ||
      existing.value !== cookie.value ||
      wholeSeconds(existing.expirationDate) !== wholeSeconds(cookie.expirationDate) ||
      (existing.secure ?? false) !== cookie.secure ||
      (existing.httpOnly ?? false) !== cookie.httpOnly ||
      existing.sameSite !== cookie.sameSite
    );
  });
  const remove = [...previous].flatMap((key) => {
    const existing = keys.has(key) ? undefined : currentByKey.get(key);
    if (existing?.domain === undefined) return [];
    const host =
      existing.hostOnly || existing.domain.startsWith(".")
        ? existing.domain
        : `.${existing.domain}`;
    return [
      {
        url: cookieScope(host, existing.path ?? "/", existing.secure ?? false).url,
        name: existing.name,
      },
    ];
  });
  return { set, remove, keys };
}

export class BrowserCookieSync extends Context.Service<
  BrowserCookieSync,
  {
    /** Keeps the target profile in step with the source from now on, replacing its earlier source. */
    readonly start: (binding: CookieSyncBinding) => Effect.Effect<void>;
    /** Stops syncing into one profile of an environment, or into all of them when `targetProfileId` is omitted. */
    readonly stop: (
      environmentId: string,
      targetProfileId: string | undefined,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/BrowserImport/BrowserCookieSync") {}

const bindingKey = (binding: Pick<CookieSyncBinding, "environmentId" | "targetProfileId">) =>
  JSON.stringify([binding.environmentId, binding.targetProfileId]);

/** @public */
export const make = Effect.gen(function* BrowserCookieSyncMake() {
  const browserImport = yield* BrowserImport.BrowserImport;
  const browserSession = yield* BrowserSession.BrowserSession;
  const app = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const syncsPath = path.join(environment.stateDir, "browser-cookie-syncs.json");

  const saved = yield* fileSystem.readFileString(syncsPath).pipe(
    Effect.flatMap(decodeCookieSyncs),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed([])
        : Effect.logWarning("Browser cookie syncs could not be read", { cause: error }).pipe(
            Effect.as([]),
          ),
    ),
  );
  const bindings = yield* Ref.make<ReadonlyArray<CookieSyncBinding>>(saved);
  const fibers = yield* FiberMap.make<string>();
  const changePermit = yield* Semaphore.make(1);

  const persist = Effect.fn("BrowserCookieSync.persist")(
    function* (next: ReadonlyArray<CookieSyncBinding>) {
      const encoded = yield* encodeCookieSyncs(next);
      const tempPath = `${syncsPath}.${process.pid}.tmp`;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(tempPath, `${encoded}\n`);
      yield* fileSystem.rename(tempPath, syncsPath);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Browser cookie syncs could not be saved", { cause }),
    ),
  );

  const run = Effect.fn("BrowserCookieSync.run")(
    function* (binding: CookieSyncBinding) {
      let previous: ReadonlySet<string> = new Set();
      const syncOnce = Effect.gen(function* () {
        const { databasePath, read } = yield* browserImport.readCookies(binding);
        const session = yield* browserSession.getSession(
          binding.scope,
          binding.persistent,
          binding.namespace,
        );
        const current = yield* Effect.tryPromise(() => session.cookies.get({}));
        const plan = planCookieSync(read.cookies, current, previous, Date.now() / 1000);
        const written = yield* BrowserImport.writeCookies(session, {
          cookies: plan.set,
          undecryptable: 0,
          undecryptableHosts: [],
        });
        yield* Effect.forEach(plan.remove, (cookie) =>
          Effect.tryPromise(() => session.cookies.remove(cookie.url, cookie.name)).pipe(
            Effect.ignore,
          ),
        );
        previous = plan.keys;
        if (plan.set.length > 0 || plan.remove.length > 0) {
          yield* Effect.logInfo("Synced browser cookies", {
            sourceId: binding.sourceId,
            targetProfileId: binding.targetProfileId,
            written: written.imported,
            removed: plan.remove.length,
          });
        }
        return databasePath;
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Browser cookie sync failed", {
            sourceId: binding.sourceId,
            targetProfileId: binding.targetProfileId,
            cause,
          }),
        ),
      );

      yield* app.whenReady;
      const databasePath = yield* syncOnce.pipe(Effect.retry(Schedule.spaced(RETRY_INTERVAL)));
      const databaseName = path.basename(databasePath);
      // Watch the directory: the database and its journal change there, and a replaced file keeps it.
      const changes = fileSystem.watch(path.dirname(databasePath)).pipe(
        Stream.filter((event) => path.basename(event.path).startsWith(databaseName)),
        Stream.retry(Schedule.spaced(RETRY_INTERVAL)),
      );
      yield* Stream.merge(changes, Stream.tick(FALLBACK_INTERVAL)).pipe(
        Stream.debounce(SETTLE),
        Stream.runForEach(() => syncOnce.pipe(Effect.ignore)),
      );
    },
    (effect, binding) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Browser cookie sync stopped", {
            sourceId: binding.sourceId,
            targetProfileId: binding.targetProfileId,
            cause,
          }),
        ),
      ),
  );

  const start = (binding: CookieSyncBinding) =>
    changePermit.withPermits(1)(
      Effect.gen(function* () {
        const key = bindingKey(binding);
        const next = [
          ...(yield* Ref.get(bindings)).filter((existing) => bindingKey(existing) !== key),
          binding,
        ];
        yield* Ref.set(bindings, next);
        yield* persist(next);
        yield* FiberMap.run(fibers, key, run(binding));
      }),
    );

  const stop = (environmentId: string, targetProfileId: string | undefined) =>
    changePermit.withPermits(1)(
      Effect.gen(function* () {
        const matches = (binding: CookieSyncBinding) =>
          binding.environmentId === environmentId &&
          (targetProfileId === undefined || binding.targetProfileId === targetProfileId);
        const current = yield* Ref.get(bindings);
        const stopped = current.filter(matches);
        if (stopped.length === 0) return;
        const next = current.filter((binding) => !matches(binding));
        yield* Ref.set(bindings, next);
        yield* persist(next);
        yield* Effect.forEach(stopped, (binding) => FiberMap.remove(fibers, bindingKey(binding)));
      }),
    );

  for (const binding of saved) yield* FiberMap.run(fibers, bindingKey(binding), run(binding));

  return BrowserCookieSync.of({ start, stop });
});

export const layer = Layer.effect(BrowserCookieSync, make);
