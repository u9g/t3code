import { describe, expect, it } from "@effect/vitest";

import { slackMessageText } from "./slackMessagePreview.ts";

describe("slackMessageText", () => {
  it.each([
    ["<@U1> and <@U2> and <@U3|carol>", "@alice and @U2 and @carol"],
    ["<#C1|general> and <#C2|>", "#general and #C2"],
    ["<!here> <!channel> <!subteam^S1|@oncall>", "@here @channel @oncall"],
    ["<!date^1392734382^{date_short}|Feb 18, 2014>", "Feb 18, 2014"],
    [
      "<https://example.com/a?b=1&amp;c=2|the doc> or <https://example.com>",
      "the doc or https://example.com",
    ],
    ["a &lt;b&gt; &amp;amp; c", "a <b> &amp; c"],
  ])("%s", (markup, text) => {
    expect(slackMessageText(markup, { U1: "alice" })).toBe(text);
  });
});
