import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitHubLinkPreview } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Fragment, type ReactNode } from "react";

import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";

import {
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
  reviewDecisionPresentation,
} from "./pullRequestPresentation";
import { buildPullRequestStackMap } from "./pullRequestStackMap.logic";

type Previews = ReadonlyMap<string, GitHubLinkPreview | null>;
const NO_PREVIEWS = Atom.make<Previews>(new Map());

/** Keyed by the environment id and the linked URLs, one per line; reads their bases up to the root. */
const stackMapPreviewsAtom = Atom.family((key: string) =>
  Atom.make((get): Previews => {
    const [environmentId, ...pending] = key.split("\n") as [EnvironmentId, ...Array<string>];
    const previews = new Map<string, GitHubLinkPreview | null>();
    for (let url = pending.shift(); url !== undefined; url = pending.shift()) {
      if (previews.has(url)) continue;
      const preview = AsyncResult.getOrElse(
        get(pullRequestEnvironment.gitHubLinkPreview({ environmentId, input: { url } })),
        () => null,
      );
      previews.set(url, preview);
      const parent = preview?.pullRequest?.parentUrl;
      if (parent != null) pending.push(parent);
    }
    return previews;
  }),
);

function status(preview: GitHubLinkPreview): { label: string; toneClassName: string } | null {
  if (preview.state === null) return null;
  const state = resolvePullRequestState({
    state: preview.state === "draft" ? "open" : preview.state,
    isDraft: preview.state === "draft",
  });
  if (preview.state === "merged" || preview.state === "closed") return state;
  const review =
    preview.state === "draft"
      ? state
      : preview.pullRequest?.reviewDecision == null
        ? null
        : reviewDecisionPresentation(preview.pullRequest.reviewDecision);
  if (preview.pullRequest?.checksState !== "failing") return review;
  return {
    label: review === null ? "Checks failing" : `${review.label} · checks failing`,
    toneClassName: pullRequestChecksStatePresentation("failing").toneClassName,
  };
}

/** A paragraph of pull request links, drawn as each repository's stacks from the base down. */
export function PullRequestStackMap({
  urls,
  environmentId,
  renderLink,
}: {
  urls: ReadonlyArray<string>;
  environmentId: EnvironmentId;
  /** The chat's own link for a URL, so a row opens and previews like any link in the reply. */
  renderLink: (url: string, label: string) => ReactNode;
}) {
  const [viewportRef, seen] = useSeenInViewport();
  const previews = useAtomValue(
    seen ? stackMapPreviewsAtom([environmentId, ...urls].join("\n")) : NO_PREVIEWS,
  );
  const groups = buildPullRequestStackMap(urls, previews);
  const oneOwner = new Set(groups.map((group) => group.repository.split("/")[0])).size === 1;
  return (
    <div
      ref={viewportRef}
      data-pull-request-stack-map
      className="my-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-2.5"
    >
      {groups.map((group) => (
        <Fragment key={group.repository}>
          <span className="pt-0.5 text-xs text-muted-foreground">
            {oneOwner ? group.repository.split("/")[1] : group.repository}
          </span>
          <div className="grid min-w-0 gap-0.5">
            {group.rows.map((row) => {
              if (row.kind === "base") {
                return (
                  <div key={row.branch} className="font-mono text-xs text-muted-foreground">
                    {row.branch}
                  </div>
                );
              }
              const state =
                row.preview?.state == null
                  ? null
                  : resolvePullRequestState({
                      state: row.preview.state === "draft" ? "open" : row.preview.state,
                      isDraft: row.preview.state === "draft",
                    });
              const rowStatus = row.preview === null ? null : status(row.preview);
              return (
                <div
                  key={row.url}
                  className={cn("flex min-w-0 items-center gap-1.5", !row.linked && "opacity-60")}
                  style={{ paddingLeft: `${row.depth * 16 - 10}px` }}
                >
                  <span
                    aria-hidden
                    className="-mt-2 h-3 w-2.5 shrink-0 rounded-bl border-b border-l border-border"
                  />
                  {state === null ? null : (
                    <state.Icon
                      role="img"
                      aria-label={state.label}
                      className={cn("size-3.5 shrink-0", state.toneClassName)}
                    />
                  )}
                  <span className="shrink-0">{renderLink(row.url, `#${row.number}`)}</span>
                  <span className="min-w-0 truncate">{row.preview?.title}</span>
                  {rowStatus === null ? null : (
                    <span className={cn("ml-auto shrink-0 pl-2 text-xs", rowStatus.toneClassName)}>
                      {rowStatus.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
