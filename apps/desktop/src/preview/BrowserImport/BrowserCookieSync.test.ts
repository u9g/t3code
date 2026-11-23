import { assert, describe, it } from "@effect/vitest";
import type { Cookie } from "electron";

import { planCookieSync } from "./BrowserCookieSync.ts";
import type { ImportedCookie } from "./CookieDatabase.ts";

const NOW = 1_800_000_000;

const imported = (overrides: Partial<ImportedCookie> = {}): ImportedCookie => ({
  url: "https://claude.ai/",
  name: "sessionKey",
  value: "new",
  domain: ".claude.ai",
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: NOW + 3600,
  sameSite: "lax",
  ...overrides,
});

const current = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "sessionKey",
  value: "new",
  domain: ".claude.ai",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  session: false,
  expirationDate: NOW + 3600.25,
  sameSite: "lax",
  ...overrides,
});

describe("planCookieSync", () => {
  it("writes only the cookies the target lacks or holds differently", () => {
    const plan = planCookieSync(
      [imported(), imported({ name: "routingHint", value: "b" }), imported({ name: "fresh" })],
      [current(), current({ name: "routingHint", value: "a" })],
      new Set(),
      NOW,
    );
    assert.deepEqual(
      plan.set.map((cookie) => cookie.name),
      ["routingHint", "fresh"],
    );
    assert.deepEqual(plan.remove, []);
  });

  it("removes what the source dropped since the last sync, and keeps the target's own cookies", () => {
    const first = planCookieSync([imported()], [], new Set(), NOW);
    const plan = planCookieSync(
      [],
      [current(), current({ name: "t3-only", domain: "example.com", hostOnly: true })],
      first.keys,
      NOW,
    );
    assert.deepEqual(plan.remove, [{ url: "https://claude.ai/", name: "sessionKey" }]);
  });

  it("matches host-only cookies to the target's undotted domain", () => {
    const plan = planCookieSync(
      [imported({ domain: undefined, name: "_dd_s" })],
      [current({ domain: "claude.ai", hostOnly: true, name: "_dd_s" })],
      new Set(),
      NOW,
    );
    assert.deepEqual(plan.set, []);
  });

  it("skips cookies that have already expired", () => {
    const plan = planCookieSync([imported({ expirationDate: NOW - 1 })], [], new Set(), NOW);
    assert.deepEqual(plan.set, []);
    assert.strictEqual(plan.keys.size, 0);
  });
});
