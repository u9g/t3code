import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// `vp pack` bundles the Node entry and every dependency into one file, so the
// relay's image is Node, that file and the migrations. The Worker deploys
// with Alchemy instead and is not built here.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: { relay: "src/node/main.ts" },
      outDir: "dist",
      platform: "node",
      clean: true,
      sourcemap: true,
      deps: { alwaysBundle: () => true, onlyBundle: false },
    },
  }),
);
