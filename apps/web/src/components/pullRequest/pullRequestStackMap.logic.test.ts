import type { GitHubLinkPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPullRequestStackMap, pullRequestStackMapUrls } from "./pullRequestStackMap.logic";

const url = (repository: string, number: number) =>
  `https://github.com/${repository}/pull/${number}`;

const preview = (baseBranch: string, parentUrl: string | null = null): GitHubLinkPreview => ({
  kind: "pull-request",
  context: "acme/web",
  title: "Title",
  description: null,
  state: "open",
  author: null,
  createdAt: null,
  pullRequest: {
    headBranch: "head",
    baseBranch,
    reviewDecision: null,
    checksState: null,
    parentUrl,
  },
});

const link = (href: string) => ({
  type: "element",
  tagName: "a",
  properties: { href },
  children: [{ type: "text", value: href }],
});
const text = (value: string) => ({ type: "text", value });
const paragraph = (...children: ReadonlyArray<unknown>) => ({
  type: "element",
  tagName: "p",
  children,
});

/** Rows as `repository: main > #1 > ..#2`, one dot pair per depth past the first, `~` when unlinked. */
const drawn = (
  linked: ReadonlyArray<string>,
  previews: ReadonlyArray<readonly [string, GitHubLinkPreview | null]>,
) =>
  buildPullRequestStackMap(linked, new Map(previews)).map(
    (group) =>
      `${group.repository}: ${group.rows
        .map((row) =>
          row.kind === "base"
            ? row.branch
            : `${"..".repeat(row.depth - 1)}${row.linked ? "" : "~"}#${row.number}`,
        )
        .join(" > ")}`,
  );

describe("pullRequestStackMapUrls", () => {
  it("reads a paragraph of only pull request links", () => {
    expect(
      pullRequestStackMapUrls(
        paragraph(
          { type: "element", tagName: "span", children: [link(url("acme/web", 1)), text(",")] },
          text(" "),
          link(`${url("acme/api", 2)}/`),
          { type: "element", tagName: "br", children: [] },
          text("\n"),
          link(url("acme/web", 1)),
        ),
      ),
    ).toEqual([url("acme/web", 1), url("acme/api", 2)]);
  });

  it.each([
    ["prose beside the link", paragraph(text("See "), link(url("acme/web", 1)))],
    ["a link that is not a pull request", paragraph(link("https://github.com/acme/web/issues/1"))],
    ["a link into a pull request", paragraph(link(`${url("acme/web", 1)}/files`))],
    ["another element", paragraph(link(url("acme/web", 1)), { type: "element", tagName: "code" })],
    ["no links", paragraph(text(" , "))],
    ["no paragraph", undefined],
  ])("is null for %s", (_name, node) => {
    expect(pullRequestStackMapUrls(node)).toBeNull();
  });
});

describe("buildPullRequestStackMap", () => {
  it("draws each repository's stacks down from their base", () => {
    expect(
      drawn(
        [url("acme/web", 12), url("acme/api", 4), url("acme/web", 11), url("acme/web", 7)],
        [
          [url("acme/web", 12), preview("followups", url("acme/web", 11))],
          [url("acme/web", 11), preview("caller", url("acme/web", 9))],
          [url("acme/web", 9), preview("main")],
          [url("acme/web", 7), preview("main")],
          [url("acme/api", 4), preview("release")],
        ],
      ),
    ).toEqual(["acme/web: main > #7 > ~#9 > ..#11 > ....#12", "acme/api: release > #4"]);
  });

  it("names a base once per run of roots on it", () => {
    expect(
      drawn(
        [url("acme/web", 1), url("acme/web", 2), url("acme/web", 3)],
        [
          [url("acme/web", 1), preview("main")],
          [url("acme/web", 2), preview("release")],
          [url("acme/web", 3), preview("release")],
        ],
      ),
    ).toEqual(["acme/web: main > #1 > release > #2 > #3"]);
  });

  it("gives a linked pull request a row before and without its preview", () => {
    expect(drawn([url("acme/web", 2), url("acme/web", 1)], [[url("acme/web", 1), null]])).toEqual([
      "acme/web: #1 > #2",
    ]);
  });

  it("shows a parent that is not read yet", () => {
    expect(
      drawn([url("acme/web", 2)], [[url("acme/web", 2), preview("caller", url("acme/web", 1))]]),
    ).toEqual(["acme/web: ~#1 > ..#2"]);
  });

  it("keeps pull requests whose bases name each other", () => {
    expect(
      drawn(
        [url("acme/web", 1), url("acme/web", 2)],
        [
          [url("acme/web", 1), preview("b", url("acme/web", 2))],
          [url("acme/web", 2), preview("a", url("acme/web", 1))],
        ],
      ),
    ).toEqual(["acme/web: b > #1 > ..#2"]);
  });
});
