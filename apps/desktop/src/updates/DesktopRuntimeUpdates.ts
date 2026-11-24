// @effect-diagnostics nodeBuiltinImport:off -- Local build manifests are exchanged with the detached installer.
import * as NodeFS from "node:fs";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  commitActiveRuntime,
  hashDesktopShell,
  readPendingRestart,
  readPendingRuntime,
  pruneRuntimeBundles,
  type RuntimeBundle,
} from "./runtimeBundle.ts";
import { applyRuntimeUpdate } from "./runtimeApply.ts";
import { runtimeHasWork } from "./runtimeWork.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-runtime-updates");

function writeJson(file: string, value: unknown): void {
  NodeFS.writeFileSync(file, JSON.stringify(value));
}
function readText(file: string): string | undefined {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
function readyFileOwnedBy(file: string, pid: number): boolean {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")).pid === pid;
  } catch {
    return false;
  }
}
function isAcknowledged(file: string, id: string): boolean {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")).id === id;
  } catch {
    return false;
  }
}
function bundledShellHash(appRoot: string): string | null {
  try {
    return hashDesktopShell(appRoot);
  } catch {
    return null;
  }
}

export const listen = Effect.fn("desktop.runtimeUpdates.listen")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const selection = environment.runtimeBundles;
  if (!selection) return;
  const state = yield* DesktopState.DesktopState;
  const backends = yield* DesktopBackendPool.DesktopBackendPool;
  const window = yield* DesktopWindow.DesktopWindow;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronApp = yield* ElectronApp.ElectronApp;
  const backend = yield* backends.primary;
  const runtimeDirectory = environment.path.join(environment.baseDir, "runtime");
  const readyPath = environment.path.join(runtimeDirectory, "runtime-updates-ready.json");
  const pendingPath = environment.path.join(runtimeDirectory, "pending-runtime.json");
  const maintenancePath = environment.path.join(runtimeDirectory, "runtime-maintenance.json");
  const restartPath = environment.path.join(runtimeDirectory, "pending-restart.json");
  // Tells the installer this quit was for its update, so it reopens the app once it is swapped in.
  const restartingPath = environment.path.join(runtimeDirectory, "restarting-for-update.json");
  const shellHash = bundledShellHash(environment.appRoot);
  if (shellHash === null) {
    yield* logError("Runtime updates unavailable: shell fingerprint could not be read");
    return;
  }
  let idleSince: number | undefined;
  let pendingText: string | undefined;
  let pending: RuntimeBundle | null = null;

  const tick = Effect.gen(function* () {
    if (yield* Ref.get(state.quitting)) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(runtimeDirectory, { recursive: true });
      const temporary = `${readyPath}.tmp`;
      writeJson(temporary, { pid: process.pid, shellHash, updatedAt: now });
      NodeFS.renameSync(temporary, readyPath);
    });
    const text = readText(pendingPath);
    if (text !== pendingText) {
      pendingText = text;
      pending =
        text === undefined
          ? null
          : readPendingRuntime(environment.baseDir, environment.appRoot, shellHash);
      idleSince = undefined;
    }
    const restart =
      !pending || pending.version === selection.current()?.version
        ? readPendingRestart(restartPath)
        : null;
    if (!restart && (!pending || pending.version === selection.current()?.version)) return;
    const snapshot = yield* backend.snapshot;
    if (
      !snapshot.desiredRunning ||
      (yield* updates.isActionActive) ||
      runtimeHasWork(environment.path.join(environment.stateDir, "statev2.sqlite"))
    ) {
      idleSince = undefined;
      return;
    }
    idleSince ??= now;
    if (now - idleSince < 60_000) return;
    const runtime = pending;
    const previous = selection.current();
    const acknowledgementPath = environment.path.join(runtimeDirectory, "runtime-quiescent.json");
    const id = `${restart?.version ?? runtime?.version}:${now}`;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const renewLease = Effect.gen(function* () {
          const leaseTime = yield* Clock.currentTimeMillis;
          yield* Effect.sync(() => {
            const temporary = `${maintenancePath}.tmp`;
            writeJson(temporary, { id, expiresAt: leaseTime + 120_000 });
            NodeFS.renameSync(temporary, maintenancePath);
          });
        });
        yield* renewLease;
        yield* renewLease.pipe(
          Effect.repeat(Schedule.spaced(Duration.seconds(10))),
          Effect.forkScoped,
        );
        const acknowledged = yield* Effect.sync(() => isAcknowledged(acknowledgementPath, id)).pipe(
          Effect.repeat({
            until: (value) => value,
            schedule: Schedule.spaced(Duration.millis(100)),
          }),
          Effect.timeoutOption(Duration.seconds(10)),
        );
        if (
          acknowledged._tag === "None" ||
          runtimeHasWork(environment.path.join(environment.stateDir, "statev2.sqlite"))
        )
          return null;
        if (restart) {
          yield* Effect.sync(() =>
            writeJson(restartingPath, { version: restart.version, pid: process.pid }),
          );
          yield* logInfo("Quitting so the installer can swap in a shell update", {
            version: restart.version,
          });
          yield* electronApp.quit;
          return "restarting" as const;
        }
        if (!runtime) return null;
        yield* logInfo("Applying runtime update without closing the window", {
          version: runtime.version,
        });
        return yield* applyRuntimeUpdate({
          runtime,
          current: previous,
          stop: backend.stop(),
          start: backend.start,
          ready: backend.waitForReady(Duration.seconds(60)),
          select: selection.select,
          commit: () => commitActiveRuntime(environment.baseDir, runtime),
          reload: Effect.void,
        });
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(maintenancePath, { force: true }))));
    if (result === "restarting") return;
    if (!runtime) {
      idleSince = undefined;
      return;
    }
    yield* logInfo(result ? "Runtime update applied" : "Runtime update deferred or restored", {
      version: runtime.version,
    });
    if (result) {
      yield* Effect.sync(() =>
        pruneRuntimeBundles(environment.baseDir, runtime.version, previous?.version),
      );
      yield* window.runMainContentsCommand("forceReload");
      yield* Effect.sync(() => {
        if (NodeFS.readFileSync(pendingPath, "utf8") === pendingText) NodeFS.rmSync(pendingPath);
      });
    }
    if (result !== null) pending = null;
    idleSince = undefined;
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (readyFileOwnedBy(readyPath, process.pid)) NodeFS.rmSync(readyPath, { force: true });
    }),
  );
  yield* tick.pipe(
    Effect.catchCause((cause) => logError("Runtime update failed", { cause })),
    Effect.repeat(Schedule.spaced(Duration.seconds(5))),
    Effect.forkScoped,
  );
});
