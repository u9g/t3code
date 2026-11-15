import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const persistence = NodeURL.fileURLToPath(
  new URL("../../server/src/persistence/", import.meta.url),
);
const hash = NodeCrypto.createHash("sha256");
for (const file of [
  "Migrations.ts",
  ...NodeFS.readdirSync(NodePath.join(persistence, "Migrations"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.relative(persistence, NodePath.join(entry.parentPath, entry.name)))
    .sort(),
]) {
  hash
    .update(file)
    .update("\0")
    .update(NodeFS.readFileSync(NodePath.join(persistence, file)));
}
NodeFS.writeFileSync(
  new URL("../dist-electron/runtime-schema.json", import.meta.url),
  JSON.stringify({
    hash: hash.digest("hex"),
    electron: JSON.parse(NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      .dependencies.electron,
  }),
);
