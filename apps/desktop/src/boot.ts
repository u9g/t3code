// A locally signed macOS build can keep its Safe Storage key in its own keychain, which macOS
// does not unlock at login. Unlock it before Chromium reads the key, whatever launched the app.
try {
  const fs = require("node:fs") as typeof import("node:fs");
  const config = JSON.parse(
    fs.readFileSync(`${process.resourcesPath}/unlock-keychain.json`, "utf8"),
  ) as { keychain: string; passwordFile: string };
  const password = fs.readFileSync(config.passwordFile, "utf8").trim();
  require("node:child_process").execFileSync(
    "/usr/bin/security",
    ["unlock-keychain", "-p", password, config.keychain],
    { stdio: "ignore", timeout: 10_000 },
  );
} catch {}
require("./compileCache.cjs");
require("./main.cjs");
