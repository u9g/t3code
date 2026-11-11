import type { EnvironmentId } from "@t3tools/contracts";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { observeResize } from "~/lib/observeResize";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { usePrimaryEnvironmentId } from "~/state/environments";

/**
 * The page a Claude artifact or Notion link points at, live in a webview below the link, in the
 * preview browser's default profile (whose logins it shares). Desktop only. Spans: it sits inside
 * paragraphs. `fullWidth` fits it to the visible timeline: the full width of its row, and the height
 * between the top of the timeline and the composer. `height` holds until that is measured.
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
  const fit = useTimelineFit(anchorRef, props.fullWidth === true && config !== null);
  if (config === null) return null;
  return (
    <span
      ref={anchorRef}
      className="my-1.5 block"
      {...(props.fullWidth ? { "data-web-embed-full-width": "" } : {})}
    >
      <span
        className="block max-w-none overflow-hidden rounded-lg border border-border bg-background"
        style={fit ?? { height: props.height, width: "100%", maxWidth: "48rem" }}
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

// Space kept between a fitted embed and the top of the timeline or the composer.
const FIT_GAP_PX = 12;
const FIT_MIN_HEIGHT_PX = 240;

interface TimelineFit {
  readonly marginLeft: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The box that fits the embed to the visible timeline. Across: its timeline row, the timeline's
 * width inside its padding, which already clears the preview panel (not the pane: the virtualized
 * list paint-contains each row). Down: from the top of the timeline to the composer floating over
 * its bottom. Null until measured, and when not enabled.
 */
function useTimelineFit(
  anchorRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): TimelineFit | null {
  const [fit, setFit] = useState<TimelineFit | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the timeline's DOM boxes, which React does not own
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const row = anchor?.closest<HTMLElement>(".messages-timeline-row-frame");
    const scroller = anchor?.closest<HTMLElement>(".messages-timeline-scroll");
    if (!enabled || !anchor || !row || !scroller) {
      setFit(null);
      return;
    }
    const composer = anchor
      .closest("[data-chat-column]")
      ?.querySelector<HTMLElement>('[data-chat-composer-stack="true"]');
    const measure = () => {
      const rowBox = row.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      const bottom = composer?.getBoundingClientRect().top ?? scrollerBox.bottom;
      const next: TimelineFit = {
        // A pixel in from each edge, so subpixel layout never pushes the border into the row's clip.
        marginLeft: Math.ceil(rowBox.left - anchorBox.left) + 1,
        width: Math.floor(rowBox.width) - 2,
        height: Math.max(FIT_MIN_HEIGHT_PX, Math.floor(bottom - scrollerBox.top) - 2 * FIT_GAP_PX),
      };
      setFit((current) =>
        current?.marginLeft === next.marginLeft &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    // The window, panels, chat width and composer (as the prompt grows) all move these edges.
    return observeResize([row, anchor, scroller, ...(composer ? [composer] : [])], measure);
  }, [anchorRef, enabled]);
  return fit;
}
