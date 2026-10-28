import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

// win32 has no friendly-name probe, so the label comes from the hostname alone.
const label = (desktopVariant: string | undefined) =>
  resolveServerEnvironmentLabel({ cwdBaseName: "repo", desktopVariant }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(HostProcess.Hostname, "box"),
  );

it.layer(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))(
  "resolveServerEnvironmentLabel",
  (it) => {
    it.effect("is the host's name for the regular app", () =>
      Effect.gen(function* () {
        expect(yield* label(undefined)).toBe("box");
        expect(yield* label("  ")).toBe("box");
      }),
    );

    it.effect("follows the host's name with a variant app's variant", () =>
      Effect.gen(function* () {
        expect(yield* label("cloud")).toBe("box (Cloud)");
      }),
    );
  },
);
