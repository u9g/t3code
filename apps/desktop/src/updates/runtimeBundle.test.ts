// @effect-diagnostics nodeBuiltinImport:off -- Runtime selection is verified against isolated filesystem bundles.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  commitActiveRuntime,
  hashDesktopShell,
  loadCompatibleRuntime,
  readPendingRuntime,
  pruneRuntimeBundles,
} from "./runtimeBundle.ts";

function setup() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-bundle-"));
  const baseDir = NodePath.join(directory, "home");
  const bundledAppRoot = NodePath.join(directory, "installed", "app.asar");
  const appRoot = NodePath.join(
    baseDir,
    "runtime",
    "bundles",
    "build-2",
    "T3 Code (Beta).app",
    "Contents",
    "Resources",
    "app.asar",
  );
  const write = (root: string, relative: string, value: string) => {
    const file = NodePath.join(root, relative);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, value);
  };
  for (const root of [bundledAppRoot, appRoot]) {
    write(root, "package.json", '{"name":"t3"}');
    write(root, "apps/desktop/package.json", '{"dependencies":{"electron":"44"}}');
    write(root, "apps/desktop/dist-electron/main.cjs", "shell");
    write(root, "apps/desktop/dist-electron/runtime-schema.json", "schema");
    write(root, "apps/server/dist/bin.mjs", "server");
    write(root, "apps/server/dist/client/index.html", "client");
    write(root, "node_modules/native/addon.node", "native");
  }
  const runtime = { version: "build-2", appRoot, shellHash: hashDesktopShell(bundledAppRoot) };
  const pending = (value: unknown = runtime) =>
    write(baseDir, "runtime/pending-runtime.json", JSON.stringify(value));
  return {
    baseDir,
    bundledAppRoot,
    appRoot,
    runtime,
    write,
    pending,
    [Symbol.dispose]() {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("runtime bundles", () => {
  it("prunes obsolete owned bundles while keeping active, previous, pending and unrelated directories", () => {
    using fixture = setup();
    const versions = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));
    const bundles = NodePath.join(fixture.baseDir, "runtime", "bundles");
    for (const version of [...versions, "user-files"])
      NodeFS.mkdirSync(NodePath.join(bundles, version), { recursive: true });
    fixture.write(
      fixture.baseDir,
      "runtime/pending-runtime.json",
      JSON.stringify({ version: versions[2] }),
    );
    pruneRuntimeBundles(fixture.baseDir, versions[0]!, versions[1]);
    for (const version of versions.slice(0, 3))
      expect(NodeFS.existsSync(NodePath.join(bundles, version))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(bundles, versions[3]!))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(bundles, "user-files"))).toBe(true);
  });
  it("accepts release metadata changes while preserving ABI inputs", () => {
    using fixture = setup();
    fixture.write(
      fixture.appRoot,
      "package.json",
      JSON.stringify({
        name: "t3",
        version: "2",
        buildVersion: "2",
        t3codeCommitHash: "new",
        build: { version: "2" },
      }),
    );
    fixture.pending();
    expect(readPendingRuntime(fixture.baseDir, fixture.bundledAppRoot)).toEqual(fixture.runtime);
  });
  it("selects matching staged code and publishes it only when committed", () => {
    using fixture = setup();
    fixture.write(fixture.appRoot, "apps/server/dist/bin.mjs", "new server");
    fixture.write(fixture.appRoot, "apps/server/dist/client/index.html", "new client");
    fixture.pending();
    expect(loadCompatibleRuntime(fixture.baseDir, fixture.bundledAppRoot)).toBeNull();
    expect(readPendingRuntime(fixture.baseDir, fixture.bundledAppRoot)).toEqual(fixture.runtime);
    commitActiveRuntime(fixture.baseDir, fixture.runtime);
    expect(loadCompatibleRuntime(fixture.baseDir, fixture.bundledAppRoot)).toEqual(fixture.runtime);
    expect(readPendingRuntime(fixture.baseDir, fixture.bundledAppRoot)).toEqual(fixture.runtime);
  });

  it.each([
    "../resource-monitor/monitor",
    "apps/desktop/dist-electron/main.cjs",
    "apps/desktop/dist-electron/runtime-schema.json",
    "package.json",
    "node_modules/native/addon.node",
  ])("refuses a changed shell input at %s", (file) => {
    using fixture = setup();
    fixture.write(fixture.appRoot, file, "changed");
    fixture.pending();
    expect(readPendingRuntime(fixture.baseDir, fixture.bundledAppRoot)).toBeNull();
    expect(() => commitActiveRuntime(fixture.baseDir, fixture.runtime)).toThrow();
  });

  it("ignores source maps and accepts a precomputed bundled shell hash", () => {
    using fixture = setup();
    fixture.write(fixture.appRoot, "apps/desktop/dist-electron/main.cjs.map", "map");
    fixture.pending();
    expect(readPendingRuntime(fixture.baseDir, "/unavailable", fixture.runtime.shellHash)).toEqual(
      fixture.runtime,
    );
  });

  it.each([
    "missing",
    "malformed",
    "version",
    "hash",
    "outside",
    "missing-server",
    "missing-client",
    "root-link",
    "file-link",
  ])("refuses an invalid staged bundle: %s", (variant) => {
    using fixture = setup();
    fixture.pending();
    switch (variant) {
      case "missing":
        NodeFS.rmSync(NodePath.join(fixture.baseDir, "runtime/pending-runtime.json"));
        break;
      case "malformed":
        fixture.write(fixture.baseDir, "runtime/pending-runtime.json", "{");
        break;
      case "version":
        fixture.pending({ ...fixture.runtime, version: "../build-2" });
        break;
      case "hash":
        fixture.pending({ ...fixture.runtime, shellHash: "a".repeat(64) });
        break;
      case "outside":
        fixture.pending({ ...fixture.runtime, appRoot: fixture.bundledAppRoot });
        break;
      case "missing-server":
        NodeFS.rmSync(NodePath.join(fixture.appRoot, "apps/server/dist/bin.mjs"));
        break;
      case "missing-client":
        NodeFS.rmSync(NodePath.join(fixture.appRoot, "apps/server/dist/client/index.html"));
        break;
      case "root-link":
        NodeFS.rmSync(fixture.appRoot, { recursive: true });
        NodeFS.symlinkSync(fixture.bundledAppRoot, fixture.appRoot, "dir");
        break;
      case "file-link": {
        const file = NodePath.join(fixture.appRoot, "apps/server/dist/bin.mjs");
        NodeFS.rmSync(file);
        NodeFS.symlinkSync(NodePath.join(fixture.bundledAppRoot, "apps/server/dist/bin.mjs"), file);
        break;
      }
    }
    expect(readPendingRuntime(fixture.baseDir, fixture.bundledAppRoot)).toBeNull();
  });

  it("keeps the active selection when a replacement is invalid", () => {
    using fixture = setup();
    commitActiveRuntime(fixture.baseDir, fixture.runtime);
    const manifestPath = NodePath.join(fixture.baseDir, "runtime/active-runtime.json");
    const before = NodeFS.readFileSync(manifestPath, "utf8");
    expect(() =>
      commitActiveRuntime(fixture.baseDir, { ...fixture.runtime, version: "../escape" }),
    ).toThrow();
    expect(NodeFS.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});
