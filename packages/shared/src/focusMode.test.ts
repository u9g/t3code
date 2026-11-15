import { describe, expect, it } from "vite-plus/test";

import {
  collapsedFocusLinks,
  extractFocusIntro,
  extractFocusLinks,
  focusLinkParagraphs,
  isFocusVideoLink,
  splitFocusSections,
} from "./focusMode.ts";

describe("extractFocusLinks", () => {
  it("collects bare, markdown, and autolinked github URLs once each", () => {
    expect(
      extractFocusLinks(
        [
          "Opened https://github.com/acme/app/pull/12.",
          "See [the issue](https://github.com/acme/app/issues/3) and <https://github.com/acme/app/pull/12>.",
          "**https://github.com/acme/app/blob/main/src/a.ts#L4**",
          "Not https://gitlab.com/acme/app or http://example.com/github.com/x",
        ].join("\n"),
      ),
    ).toEqual([
      "https://github.com/acme/app/pull/12",
      "https://github.com/acme/app/issues/3",
      "https://github.com/acme/app/blob/main/src/a.ts#L4",
    ]);
  });

  it("keeps .mp4 links, including markdown links to local videos, in reply order", () => {
    expect(
      extractFocusLinks(
        [
          "Recording: [demo video](/Users/me/demo.mp4).",
          "Also at https://cdn.example.com/a/demo.mp4?sig=1, PR https://github.com/acme/app/pull/12",
          "and https://cdn.example.com/a/demo.mp4?sig=1 again.",
        ].join("\n"),
      ),
    ).toEqual([
      "[demo video](/Users/me/demo.mp4)",
      "https://cdn.example.com/a/demo.mp4?sig=1",
      "https://github.com/acme/app/pull/12",
    ]);
  });

  it("returns nothing when no github URL is present", () => {
    expect(extractFocusLinks("Done. Tests pass.")).toEqual([]);
  });
});

describe("isFocusVideoLink", () => {
  it("matches bare and markdown .mp4 links only", () => {
    expect(isFocusVideoLink("[demo video](/Users/me/demo.mp4)")).toBe(true);
    expect(isFocusVideoLink("https://cdn.example.com/a/demo.mp4?sig=1")).toBe(true);
    expect(isFocusVideoLink("https://github.com/acme/app/pull/12")).toBe(false);
  });
});

describe("splitFocusSections", () => {
  it("splits at headings, keeps the intro, and ignores headings in code fences", () => {
    expect(
      splitFocusSections(
        [
          "Preamble.",
          "## Summary",
          "Did things.",
          "",
          "```sh",
          "# not a heading",
          "```",
          "### Next steps",
          "- more",
        ].join("\n"),
      ),
    ).toEqual([
      { heading: null, body: "Preamble." },
      { heading: "## Summary", body: "Did things.\n\n```sh\n# not a heading\n```" },
      { heading: "### Next steps", body: "- more" },
    ]);
  });

  it("omits an empty intro and returns nothing for text without headings", () => {
    expect(splitFocusSections("## Only\nbody")).toEqual([{ heading: "## Only", body: "body" }]);
    expect(splitFocusSections("Just a reply.\n#hashtag")).toEqual([]);
  });
});

describe("extractFocusIntro", () => {
  it("returns the first prose paragraph, skipping headings, lists and code", () => {
    expect(
      extractFocusIntro(
        [
          "## Summary",
          "",
          "- https://github.com/a/b/pull/1",
          "",
          "Merged the fix.\nCI is green.",
          "",
          "More.",
        ].join("\n"),
      ),
    ).toBe("Merged the fix.\nCI is green.");
  });

  it("is null when the reply has no prose paragraph", () => {
    expect(
      extractFocusIntro("- https://github.com/a/b/pull/1\n- https://github.com/a/b/pull/2"),
    ).toBeNull();
  });
});

describe("collapsedFocusLinks", () => {
  const pr = "https://github.com/u9g/t3code/pull/1";
  const video = "https://example.com/demo.mp4";

  it("keeps GitHub links the intro does not already carry", () => {
    expect(collapsedFocusLinks([pr, video], "Opened a PR.", false)).toEqual([pr, video]);
    expect(collapsedFocusLinks([pr, video], `Opened ${pr}.`, false)).toEqual([video]);
    expect(collapsedFocusLinks([pr, video], null, false)).toEqual([pr, video]);
  });

  it("keeps an earlier reply's GitHub links but not its videos", () => {
    expect(collapsedFocusLinks([pr, video], null, true)).toEqual([pr]);
  });
});

describe("focusLinkParagraphs", () => {
  const pr = "https://github.com/acme/web/pull/1";
  const otherPr = "https://github.com/acme/web/pull/2";
  const commit = "https://github.com/acme/web/commit/abc123";
  const video = "https://example.com/demo.mp4";

  it.each([
    [[pr, otherPr], [`${pr}\n${otherPr}`]],
    [
      [pr, commit],
      [pr, commit],
    ],
    [
      [pr, video],
      [pr, video],
    ],
    [
      [commit, pr],
      [commit, pr],
    ],
    [
      [commit, commit],
      [commit, commit],
    ],
    [
      [commit, video],
      [commit, video],
    ],
    [
      [video, pr],
      [video, pr],
    ],
    [
      [video, commit],
      [video, commit],
    ],
    [
      [video, video],
      [video, video],
    ],
    [
      [pr, commit, otherPr],
      [pr, commit, otherPr],
    ],
    [[], []],
  ])("keeps only adjacent PR links in one paragraph: %j", (links, expected) => {
    expect(focusLinkParagraphs(links)).toEqual(expected);
  });
});
