import { describe, expect, it } from "vite-plus/test";

import { isWebEmbedLink, WEB_EMBED_LINKS } from "./webEmbedLinks.ts";

describe("isWebEmbedLink", () => {
  it.each([
    ["https://claude.ai/artifact/KzrwDZA2ZHwGddTSK4Woso", true],
    ["https://claude.ai/code/artifact/99d8aa06-96a5-4e85-843a-a3b2e3723032", true],
    ["https://claude.ai/public/artifacts/99d8aa06-96a5-4e85-843a-a3b2e3723032", true],
    ["https://www.notion.so/livekit/Outlast-the-Minute-4143c4901a428164a811fc6f131033fe", true],
    ["https://notion.so/4143c4901a428164a811fc6f131033fe?v=0e3c4901a428164a811fc6f131033fe", true],
    ["https://app.notion.com/p/livekit/Outlast-the-Minute-4143c4901a428164a811fc6f131033fe", true],
    ["https://livekit.notion.site/Outlast-the-Minute-4143c4901a428164a811fc6f131033fe", true],
    ["https://claude.ai/chat/99d8aa06-96a5-4e85-843a-a3b2e3723032", false],
    ["https://www.notion.so/livekit", false],
    ["https://notion.so.evil.test/4143c4901a428164a811fc6f131033fe", false],
    ["https://claude.ai.evil.test/artifact/KzrwDZA2ZHwGddTSK4Woso", false],
  ])("%s", (url, embedded) => {
    expect(isWebEmbedLink(url)).toBe(embedded);
  });
});

describe("WEB_EMBED_LINKS", () => {
  it("leaves sentence punctuation out of the link", () => {
    const text =
      "See https://claude.ai/artifact/KzrwDZA2ZHwGddTSK4Woso, and (https://www.notion.so/livekit/Plan-4143c4901a428164a811fc6f131033fe).";
    expect(Array.from(text.matchAll(WEB_EMBED_LINKS), (match) => match[0])).toEqual([
      "https://claude.ai/artifact/KzrwDZA2ZHwGddTSK4Woso",
      "https://www.notion.so/livekit/Plan-4143c4901a428164a811fc6f131033fe",
    ]);
  });
});
