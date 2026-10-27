const NodeFs = require("node:fs") as typeof import("node:fs");
const NodeOs = require("node:os") as typeof import("node:os");
const NodePath = require("node:path") as typeof import("node:path");

// A variant build (see T3CODE_DESKTOP_VARIANT in scripts/build-desktop-artifact.ts) keeps its
// data apart from the regular app's before anything reads T3CODE_HOME. Read at runtime, since
// the bundler would inline a required package.json.
const variant = (() => {
  try {
    const packageJsonPath = NodePath.join(__dirname, "../../../package.json");
    const value: unknown = JSON.parse(NodeFs.readFileSync(packageJsonPath, "utf8")).t3codeVariant;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
})();
if (variant) {
  process.env.T3CODE_DESKTOP_VARIANT = variant;
  process.env.T3CODE_HOME ||= NodePath.join(NodeOs.homedir(), `.t3-${variant}`);
}

require("./compileCache.cjs");
require("./main.cjs");
