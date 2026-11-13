import { EnvironmentId, type GitHubLinkPreview } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const previews = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const atoms = new Map<string, unknown>();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      gitHubLinkPreview: (({ input }: { input: { url: string } }) => {
        if (!atoms.has(input.url)) {
          atoms.set(input.url, Atom.make(AsyncResult.success(previews.get(input.url) ?? null)));
        }
        return atoms.get(input.url);
      }) as never,
    },
  };
});

import { render } from "../../../test/render";
import { PullRequestStackMap } from "./PullRequestStackMap";

const url = (repository: string, number: number) =>
  `https://github.com/${repository}/pull/${number}`;

const preview = (
  title: string,
  state: GitHubLinkPreview["state"],
  pullRequest: Partial<NonNullable<GitHubLinkPreview["pullRequest"]>>,
): GitHubLinkPreview => ({
  kind: "pull-request",
  context: "acme/web",
  title,
  description: null,
  state,
  author: null,
  createdAt: null,
  pullRequest: {
    headBranch: "head",
    baseBranch: "main",
    reviewDecision: null,
    checksState: null,
    parentUrl: null,
    ...pullRequest,
  },
});

it("draws the linked pull requests under the parents they are stacked on", async () => {
  previews.set(url("acme/web", 1), preview("Caller", "open", { reviewDecision: "approved" }));
  previews.set(
    url("acme/web", 2),
    preview("Follow-ups", "open", { baseBranch: "caller", parentUrl: url("acme/web", 1) }),
  );
  previews.set(
    url("acme/web", 3),
    preview("Metrics", "draft", {
      baseBranch: "followups",
      parentUrl: url("acme/web", 2),
      checksState: "failing",
    }),
  );
  previews.set(url("acme/api", 9), preview("Gateway name", "merged", {}));

  await using screen = await render(
    <PullRequestStackMap
      urls={[url("acme/api", 9), url("acme/web", 2), url("acme/web", 3)]}
      environmentId={EnvironmentId.make("environment")}
      renderLink={(href, label) => <a href={href}>{label}</a>}
    />,
  );

  await expect.element(screen.getByText("Caller")).toBeVisible();
  const lines = [
    ...screen.container.querySelectorAll("[data-pull-request-stack-map] > div > div"),
  ].map((row) => row.textContent);
  expect(lines).toEqual([
    "main",
    "#9Gateway nameMerged",
    "main",
    "#1CallerApproved",
    "#2Follow-ups",
    "#3MetricsDraft · checks failing",
  ]);
  expect(
    [...screen.container.querySelectorAll("[data-pull-request-stack-map] > span")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["api", "web"]);
  // Only the parent no link names is dimmed.
  expect(
    [...screen.container.querySelectorAll(".opacity-60")].map(
      (row) => row.querySelector("a")?.textContent,
    ),
  ).toEqual(["#1"]);
});
