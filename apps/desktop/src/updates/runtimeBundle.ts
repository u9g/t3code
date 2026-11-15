// @effect-diagnostics nodeBuiltinImport:off -- Resolves the packaged runtime before Effect services start.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface RuntimeBundle {
  readonly version: string;
  readonly appRoot: string;
  readonly shellHash: string;
}

const isWithin = (root: string, target: string): boolean => {
  const relative = NodePath.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

/** Includes shell code and native ABI inputs; server and client payloads may change independently. */
export function hashDesktopShell(appRoot: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const addFile = (relative: string) => {
    const file = NodePath.join(appRoot, relative);
    let bytes = NodeFS.readFileSync(file);
    const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
    if (
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Fingerprints run before desktop services exist and in detached build scripts.
      NodeOS.platform() === "darwin" &&
      [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca].includes(magic)
    ) {
      const signature = NodeChildProcess.spawnSync("/usr/bin/codesign", ["-dvvv", file], {
        encoding: "utf8",
      });
      const cdhash = signature.stderr?.match(/^CDHash=([a-f0-9]+)$/m)?.[1];
      // CodeDirectory excludes the signing timestamp while retaining code and entitlements.
      if (signature.status === 0 && cdhash) bytes = Buffer.from(cdhash);
    }
    hash.update(`${relative.split(NodePath.sep).join("/")}\0${bytes.length}\0`);
    hash.update(bytes);
  };
  const walk = (relative: string, nativeOnly: boolean) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(appRoot, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const child = NodePath.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Runtime shell contains a symbolic link: ${child}`);
      if (entry.isDirectory()) walk(child, nativeOnly);
      else if (
        entry.isFile() &&
        (nativeOnly ? entry.name.endsWith(".node") : !entry.name.endsWith(".map"))
      )
        addFile(child);
    }
  };
  const metadata = JSON.parse(
    NodeFS.readFileSync(NodePath.join(appRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  delete metadata.version;
  delete metadata.buildVersion;
  delete metadata.t3codeCommitHash;
  delete metadata.build;
  hash.update(JSON.stringify(metadata));
  addFile("apps/desktop/dist-electron/runtime-schema.json");
  walk(NodePath.join("apps", "desktop", "dist-electron"), false);
  if (NodeFS.existsSync(NodePath.join(appRoot, "node_modules"))) walk("node_modules", true);
  for (const directory of [
    "apps/desktop/prod-resources",
    "../resource-monitor",
    "../browser-secret",
    "../hyprland-capture",
    "../kde-capture",
  ]) {
    const exists = NodeFS.existsSync(NodePath.join(appRoot, directory));
    hash.update(`${directory}:${exists}`);
    if (exists) walk(directory, false);
  }
  return hash.digest("hex");
}

function parseRuntime(baseDir: string, value: unknown): RuntimeBundle | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, appRoot, shellHash } = value as Partial<RuntimeBundle>;
  if (
    typeof version !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(version) ||
    typeof appRoot !== "string" ||
    !NodePath.isAbsolute(appRoot) ||
    typeof shellHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(shellHash)
  )
    return null;
  const versionRoot = NodePath.resolve(baseDir, "runtime", "bundles", version);
  const expectedRoot = NodePath.join(
    versionRoot,
    "T3 Code (Beta).app",
    "Contents",
    "Resources",
    "app.asar",
  );
  const canonicalRoot = NodePath.join(
    NodeFS.realpathSync(baseDir),
    "runtime",
    "bundles",
    version,
    "T3 Code (Beta).app",
    "Contents",
    "Resources",
    "app.asar",
  );
  if (NodePath.resolve(appRoot) !== expectedRoot || NodeFS.realpathSync(appRoot) !== canonicalRoot)
    return null;
  for (const relative of ["apps/server/dist/bin.mjs", "apps/server/dist/client/index.html"]) {
    const file = NodePath.join(appRoot, relative);
    if (!isWithin(canonicalRoot, NodeFS.realpathSync(file)) || !NodeFS.statSync(file).isFile())
      return null;
  }
  return { version, appRoot: expectedRoot, shellHash };
}

function readRuntime(
  baseDir: string,
  bundledAppRoot: string,
  file: string,
  expectedShellHash?: string,
): RuntimeBundle | null {
  try {
    const runtime = parseRuntime(
      baseDir,
      JSON.parse(NodeFS.readFileSync(NodePath.join(baseDir, "runtime", file), "utf8")),
    );
    if (!runtime) return null;
    const bundledHash = expectedShellHash ?? hashDesktopShell(bundledAppRoot);
    return runtime.shellHash === bundledHash && hashDesktopShell(runtime.appRoot) === bundledHash
      ? runtime
      : null;
  } catch {
    return null;
  }
}

export const loadCompatibleRuntime = (
  baseDir: string,
  bundledAppRoot: string,
  expectedShellHash?: string,
): RuntimeBundle | null =>
  readRuntime(baseDir, bundledAppRoot, "active-runtime.json", expectedShellHash);

export const readPendingRuntime = (
  baseDir: string,
  bundledAppRoot: string,
  expectedShellHash?: string,
): RuntimeBundle | null =>
  readRuntime(baseDir, bundledAppRoot, "pending-runtime.json", expectedShellHash);

/** Publish only after the replacement backend is ready; a failed apply leaves the previous selection. */
export function commitActiveRuntime(baseDir: string, runtime: RuntimeBundle): void {
  const validated = parseRuntime(baseDir, runtime);
  if (!validated || hashDesktopShell(validated.appRoot) !== validated.shellHash)
    throw new Error("Invalid runtime bundle");
  const directory = NodePath.join(baseDir, "runtime");
  NodeFS.mkdirSync(directory, { recursive: true });
  if (NodeFS.lstatSync(directory).isSymbolicLink())
    throw new Error("Runtime directory must not be a symbolic link");
  const temporary = NodePath.join(directory, `.active-runtime-${NodeCrypto.randomUUID()}.json`);
  NodeFS.writeFileSync(temporary, `${JSON.stringify(validated)}\n`, { flag: "wx", mode: 0o600 });
  NodeFS.renameSync(temporary, NodePath.join(directory, "active-runtime.json"));
}

export function pruneRuntimeBundles(
  baseDir: string,
  version: string,
  previousVersion: string | undefined,
): void {
  try {
    const directory = NodePath.join(baseDir, "runtime", "bundles");
    const keep = new Set([version, previousVersion]);
    try {
      const pending = JSON.parse(
        NodeFS.readFileSync(NodePath.join(baseDir, "runtime", "pending-runtime.json"), "utf8"),
      ) as { version?: string };
      keep.add(pending.version);
    } catch {
      /* A missing pending bundle has no files to retain. */
    }
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name) && !keep.has(entry.name)) {
        NodeFS.rmSync(NodePath.join(directory, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    /* Cleanup must not undo a successful activation. */
  }
}
