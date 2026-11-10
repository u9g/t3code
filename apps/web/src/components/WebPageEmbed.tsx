import type { EnvironmentId } from "@t3tools/contracts";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { observeResize } from "~/lib/observeResize";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { usePrimaryEnvironmentId } from "~/state/environments";

/**
 * The page a Claude artifact or Notion link points at, live in a webview below the link, in the
 * preview browser's default profile (whose logins it shares). Desktop only. Spans: it sits inside
 * paragraphs. `fullWidth` stretches it past the chat column to the full width of its timeline row.
 */
export function WebPageEmbed(props: { url: string; height: number; fullWidth?: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  const [viewportRef, seen] = useSeenInViewport();
  return (
    <span ref={viewportRef} className="block">
      {seen && environmentId !== null ? (
        <WebPageEmbedWebview {...props} environmentId={environmentId} />
      ) : null}
    </span>
  );
}

function WebPageEmbedWebview(props: {
  url: string;
  height: number;
  fullWidth?: boolean;
  environmentId: EnvironmentId;
}) {
  const config = usePreviewWebviewConfig(props.environmentId);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  // The anchor mounts with the config, so measuring waits for it.
  const breakout = useTimelineRowBreakout(anchorRef, props.fullWidth === true && config !== null);
  if (config === null) return null;
  return (
    <span
      ref={anchorRef}
      className="my-1.5 block"
      {...(props.fullWidth ? { "data-web-embed-full-width": "" } : {})}
    >
      <span
        className="block max-w-none overflow-hidden rounded-lg border border-border bg-background"
        style={{
          height: props.height,
          ...(breakout ?? { width: "100%", maxWidth: "48rem" }),
        }}
      >
        <webview
          src={props.url}
          partition={config.partition}
          webpreferences={config.webPreferences}
          style={{ display: "flex", width: "100%", height: "100%" }}
        />
      </span>
    </span>
  );
}

/**
 * Where the embed must sit, relative to its place in the chat column, to span its timeline row:
 * the timeline's width inside its padding, which already clears the preview panel. Not the pane,
 * since the virtualized list paint-contains each row. Null until measured, and when not enabled.
 */
function useTimelineRowBreakout(
  anchorRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { marginLeft: number; width: number } | null {
  const [box, setBox] = useState<{ marginLeft: number; width: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the timeline row's DOM box, which React does not own
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const row = anchor?.closest<HTMLElement>(".messages-timeline-row-frame");
    if (!enabled || !anchor || !row) {
      setBox(null);
      return;
    }
    const measure = () => {
      const rowBox = row.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const next = {
        // A pixel in from each edge, so subpixel layout never pushes the border into the row's clip.
        marginLeft: Math.ceil(rowBox.left - anchorBox.left) + 1,
        width: Math.floor(rowBox.width) - 2,
      };
      setBox((current) =>
        current?.marginLeft === next.marginLeft && current.width === next.width ? current : next,
      );
    };
    measure();
    // The row resizes with the window and panels; the column moves inside it with chat width.
    return observeResize([row, anchor], measure);
  }, [anchorRef, enabled]);
  return box;
}
