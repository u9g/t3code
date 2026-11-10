import { describe, expect, it } from "vite-plus/test";

import { parseSlackMessageLink, SLACK_MESSAGE_LINKS } from "./slackMessageLinks.ts";

describe("parseSlackMessageLink", () => {
  it.each([
    [
      "https://acme.slack.com/archives/C07TWVC0W4A/p1794334516271309",
      { channel: "C07TWVC0W4A", ts: "1794334516.271309", threadTs: null },
    ],
    [
      "https://acme.slack.com/archives/C07TWVC0W4A/p1794334516271309?thread_ts=1794328378.273879&cid=C07TWVC0W4A",
      { channel: "C07TWVC0W4A", ts: "1794334516.271309", threadTs: "1794328378.273879" },
    ],
    [
      "https://acme.enterprise.slack.com/archives/D0BTH8UN6SC/p1794290460489439",
      { channel: "D0BTH8UN6SC", ts: "1794290460.489439", threadTs: null },
    ],
    ["https://acme.slack.com/archives/C07TWVC0W4A", null],
    ["https://app.slack.com/client/T011XFG55FY/C07TWVC0W4A", null],
    ["https://slack.com.evil.test/archives/C07TWVC0W4A/p1794334516271309", null],
    ["see https://acme.slack.com/archives/C07TWVC0W4A/p1794334516271309", null],
  ])("%s", (url, link) => {
    expect(parseSlackMessageLink(url)).toEqual(link);
  });
});

describe("SLACK_MESSAGE_LINKS", () => {
  it("leaves sentence punctuation out of the link", () => {
    const text =
      "Both https://acme.slack.com/archives/C1/p1794334516271309, and (https://acme.slack.com/archives/C2/p1794334516271309?thread_ts=1794328378.273879).";
    expect(Array.from(text.matchAll(SLACK_MESSAGE_LINKS), (match) => match[0])).toEqual([
      "https://acme.slack.com/archives/C1/p1794334516271309",
      "https://acme.slack.com/archives/C2/p1794334516271309?thread_ts=1794328378.273879",
    ]);
  });
});
