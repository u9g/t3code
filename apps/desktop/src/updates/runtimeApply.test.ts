import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { applyRuntimeUpdate } from "./runtimeApply.ts";
import type { RuntimeBundle } from "./runtimeBundle.ts";

describe("runtime replacement", () => {
  it.effect.each(["none", "start", "readiness", "commit"] as const)(
    "keeps the selected backend consistent on %s",
    (failure) =>
      Effect.gen(function* () {
        const current: RuntimeBundle = { version: "old", appRoot: "/old", shellHash: "hash" };
        const runtime: RuntimeBundle = { ...current, version: "new", appRoot: "/new" };
        let selected: RuntimeBundle | null = current;
        let running: string | undefined = "old";
        let persisted = current;
        let reloaded = false;
        const result = yield* applyRuntimeUpdate({
          current,
          runtime,
          select: (value) => {
            selected = value;
          },
          stop: Effect.sync(() => {
            running = undefined;
          }),
          start: Effect.sync(() => {
            if (failure === "start" && selected === runtime) throw new Error("cannot start");
            running = selected?.version;
          }),
          ready: Effect.sync(() => failure !== "readiness" || selected !== runtime),
          commit: () => {
            if (failure === "commit") throw new Error("cannot persist selection");
            assert.equal(running, "new");
            persisted = runtime;
          },
          reload: Effect.sync(() => {
            assert.equal(persisted, runtime);
            reloaded = true;
          }),
        });
        assert.equal(result, failure === "none");
        assert.equal(running, failure === "none" ? "new" : "old");
        assert.equal(selected, failure === "none" ? runtime : current);
        assert.equal(persisted, selected);
        assert.equal(reloaded, result);
      }),
  );
});
