import type { EnvironmentId } from "@t3tools/contracts";
import { cloneElement, useState, type ReactElement, type Ref } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { PullRequestActorAvatar } from "./pullRequestPresentation";

const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged", draft: "Draft" } as const;

/** A hover card for any github.com link, read once the link is on screen so hovering finds it ready. */
export function GitHubLinkPreview({
  link,
  url,
  environmentId,
}: {
  link: ReactElement;
  url: string;
  environmentId: EnvironmentId | null;
}) {
  const [open, setOpen] = useState(false);
  const [viewportRef, seen] = useSeenInViewport();
  const preview = useEnvironmentQuery(
    (open || seen) && environmentId !== null
      ? pullRequestEnvironment.gitHubLinkPreview({ environmentId, input: { url } })
      : null,
  ).data;
  const code = preview?.code;

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        render={cloneElement(link as ReactElement<{ ref?: Ref<Element> }>, { ref: viewportRef })}
        delay={0}
        closeDelay={120}
      />
      <PreviewCardPopup
        side="right"
        collisionAvoidance={{ side: "none", align: "shift" }}
        className={cn(code ? "w-[36rem]" : "w-80", "max-w-(--available-width)")}
      >
        <div className="p-3">
          {preview === null ? (
            <p className="break-all text-xs text-muted-foreground">{url}</p>
          ) : (
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                <span className="min-w-0 truncate">{preview.context}</span>
                {preview.state === null ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{STATE_LABEL[preview.state]}</span>
                  </>
                )}
              </div>
              <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
                {preview.title}
              </p>
              {preview.description ? (
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                  {preview.description}
                </p>
              ) : null}
              {code === undefined ? null : (
                <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/50 py-1.5 font-mono text-2xs leading-relaxed">
                  {code.text.split("\n").map((line, index) => {
                    const lineNumber = code.startLine + index;
                    return (
                      <div key={lineNumber} className="flex">
                        <span className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground/60">
                          {lineNumber}
                        </span>
                        <span className="whitespace-pre pr-3">{line}</span>
                      </div>
                    );
                  })}
                </pre>
              )}
              {preview.author === null && preview.createdAt === null ? null : (
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {preview.author === null ? null : (
                    <>
                      <PullRequestActorAvatar actor={preview.author} className="size-4" />
                      <span className="min-w-0 truncate">{preview.author.login}</span>
                    </>
                  )}
                  {preview.author !== null && preview.createdAt !== null ? (
                    <span aria-hidden>·</span>
                  ) : null}
                  {preview.createdAt === null ? null : (
                    <span className="shrink-0">
                      <RelativeTime timestamp={preview.createdAt} />
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
