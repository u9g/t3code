import { RelativeTime } from "~/components/RelativeTime";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { slackMessagePreview } from "~/state/slack";

/**
 * The message a Slack permalink points at, framed below the link. Slack runs beside the client,
 * so the primary environment reads it whichever environment the thread is on. Spans throughout:
 * it sits inside paragraphs.
 */
export function SlackMessageEmbed({ url }: { url: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const [viewportRef, seen] = useSeenInViewport();
  const preview = useEnvironmentQuery(
    seen && environmentId !== null ? slackMessagePreview({ environmentId, input: { url } }) : null,
  ).data;

  return (
    <span ref={viewportRef}>
      {preview === null ? null : (
        <span className="my-1.5 flex w-fit max-w-xl gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left text-xs font-normal text-foreground">
          {preview.avatarUrl === null ? null : (
            <img
              aria-hidden
              alt=""
              src={preview.avatarUrl}
              className="size-8 shrink-0 rounded-md"
            />
          )}
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground">
              {preview.author === null ? null : (
                <span className="min-w-0 truncate font-medium text-foreground">
                  {preview.author}
                </span>
              )}
              {preview.conversation === null ? null : (
                <span className="min-w-0 truncate">{preview.conversation}</span>
              )}
              <span className="shrink-0">
                <RelativeTime timestamp={preview.postedAt} />
              </span>
            </span>
            <span className="mt-0.5 line-clamp-6 whitespace-pre-wrap wrap-break-word">
              {preview.text}
            </span>
            {preview.replyCount === 0 ? null : (
              <span className="mt-1 block text-muted-foreground">
                {preview.replyCount === 1 ? "1 reply" : `${preview.replyCount} replies`}
              </span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
