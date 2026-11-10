import type { EnvironmentId } from "@t3tools/contracts";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { observeResize } from "~/lib/observeResize";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { usePrimaryEnvironmentId } from "~/state/environments";

// Space kept between a full-width embed and the edges of the chat pane.
const FULL_WIDTH_GUTTER_PX = 16;

/**
 * The page a Claude artifact or Notion link points at, live in a webview below the link, in the
 * preview browser's default profile (whose logins it shares). Desktop only. Spans: it sits inside
 * paragraphs. `fullWidth` stretches it past the chat column to the edges of the chat pane.
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
  const breakout = useChatPaneBreakout(anchorRef, props.fullWidth === true && config !== null);
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
 * Where the embed must sit, relative to its place in the chat column, to span the chat pane
 * minus whatever the preview panel covers. Null until measured, and when not enabled.
 */
function useChatPaneBreakout(
  anchorRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { marginLeft: number; width: number } | null {
  const [box, setBox] = useState<{ marginLeft: number; width: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the chat pane's DOM box, which React does not own
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const pane = anchor?.closest<HTMLElement>("[data-chat-canvas]");
    if (!enabled || !anchor || !pane) {
      setBox(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(pane);
      const insetStart = Number.parseFloat(style.getPropertyValue("--chat-lane-inset-start")) || 0;
      const insetEnd = Number.parseFloat(style.getPropertyValue("--chat-lane-inset-end")) || 0;
      const paneBox = pane.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const left = paneBox.left + insetStart + FULL_WIDTH_GUTTER_PX;
      const right = paneBox.right - insetEnd - FULL_WIDTH_GUTTER_PX;
      const next = {
        marginLeft: Math.round(left - anchorBox.left),
        width: Math.round(right - left),
      };
      setBox((current) =>
        current?.marginLeft === next.marginLeft && current.width === next.width ? current : next,
      );
    };
    measure();
    // The pane resizes with the window and panels; the column moves inside it with chat width.
    return observeResize([pane, anchor], measure);
  }, [anchorRef, enabled]);
  return box;
}
