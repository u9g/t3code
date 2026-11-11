import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { previewBridge } from "~/components/preview/previewBridge";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
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
  // Per link, so the choice follows it across threads and restarts.
  const [minimized, setMinimized] = useLocalStorage(
    `${WEB_EMBED_MINIMIZED_KEY_PREFIX}${props.url}`,
    false,
    Schema.Boolean,
  );
  const { title, bindWebview } = useEmbedPage(props.url);
  // The anchor mounts with the config, so measuring waits for it.
  const fit = useTimelineFit(anchorRef, props.fullWidth === true && config !== null);
  useFitScrollDetent(anchorRef, fit !== null && !minimized);
  if (config === null) return null;
  const across = fit
    ? { marginLeft: fit.marginLeft, width: fit.width }
    : { width: "100%", maxWidth: "48rem" };
  return (
    <span
      ref={anchorRef}
      className="my-1.5 block"
      {...(props.fullWidth ? { "data-web-embed-full-width": "" } : {})}
    >
      {/* A window frame: the title bar's strip runs on, half as thick, down both sides and along the bottom. */}
      <span
        className={cn(
          "group/web-embed-frame flex max-w-none cursor-pointer flex-col rounded-xl border border-border bg-muted px-4 hover:bg-accent",
          !minimized && "pb-4",
        )}
        // :hover does not reach an element whose webview holds the pointer; pointer events do.
        onPointerEnter={(event) =>
          event.currentTarget.toggleAttribute("data-web-embed-hovered", true)
        }
        onPointerLeave={(event) =>
          event.currentTarget.toggleAttribute("data-web-embed-hovered", false)
        }
        // The whole band minimizes and restores, not only the title. The title bar's click (and
        // its keyboard activation) bubbles here; the page's own input never reaches the host.
        onClick={(event) => {
          if (!(event.target as Element).closest("[data-web-embed-page]")) {
            setMinimized((value) => !value);
          }
        }}
        style={{ ...across, height: minimized ? "auto" : (fit?.height ?? props.height) }}
      >
        <button
          type="button"
          aria-expanded={!minimized}
          className="-mx-4 flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg ps-2.5 pe-3 text-left text-xs text-muted-foreground group-hover/web-embed-frame:text-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 transition-transform", !minimized && "rotate-90")}
          />
          <span className="truncate font-medium text-foreground">
            {title ?? webEmbedKind(props.url)}
          </span>
          <span className="truncate">{webEmbedHost(props.url)}</span>
        </button>
        {minimized ? null : (
          <span
            data-web-embed-page=""
            className="relative flex min-h-0 flex-1 cursor-auto overflow-hidden rounded-lg bg-background"
          >
            <webview
              ref={bindWebview}
              src={props.url}
              partition={config.partition}
              webpreferences={config.webPreferences}
              style={{ display: "flex", width: "100%", height: "100%" }}
            />
            {/* Drawn over the page, which paints as its own layer and would cover a box border. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 rounded-lg border border-border"
            />
          </span>
        )}
      </span>
    </span>
  );
}

const WEB_EMBED_MINIMIZED_KEY_PREFIX = "t3code:web-embed-minimized:";

// Page titles seen this session, so a minimized embed (whose page is unloaded) keeps its name.
const pageTitles = new Map<string, string>();

/**
 * The page's title once it loads, and a ref that hands the webview to the desktop, which keeps
 * where the page was scrolled (in every frame) across unloads: thread switches and minimizing.
 */
function useEmbedPage(url: string) {
  const [title, setTitle] = useState(() => pageTitles.get(url) ?? null);
  const bindWebview = (element: HTMLElement | null) => {
    if (!element) return;
    const webview = element as HTMLElement & { getWebContentsId: () => number };
    const onTitle = (event: Event) => {
      const next = (event as Event & { title?: string }).title?.trim();
      if (!next) return;
      pageTitles.set(url, next);
      setTitle(next);
    };
    const onReady = () => {
      void previewBridge?.trackEmbedScroll(webview.getWebContentsId(), url).catch(() => undefined);
    };
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("dom-ready", onReady);
    return () => {
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("dom-ready", onReady);
    };
  };
  return { title, bindWebview };
}

function webEmbedKind(url: string): string {
  return new URL(url).hostname === "claude.ai" ? "Claude artifact" : "Notion page";
}

function webEmbedHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
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

// The lock holds at least this long, then until scrolling input pauses this long: a swipe's
// momentum arrives as a steady stream, so only a new swipe gets past.
const DETENT_MIN_HOLD_MS = 600;
const DETENT_QUIET_MS = 200;

/**
 * Stops a scroll gesture, momentum included, that carries the embed across its fitted position
 * exactly there; the next gesture scrolls past. The lock hides the timeline's overflow, since only
 * a gesture's first wheel event is cancelable. A crossing counts only while the user scrolls,
 * so programmatic scrolls (scroll to end) pass.
 */
function useFitScrollDetent(anchorRef: RefObject<HTMLElement | null>, enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds scroll listeners and the lock's overflow style on the timeline scroller while the embed is mounted
  useEffect(() => {
    const anchor = anchorRef.current;
    const scroller = anchor?.closest<HTMLElement>(".messages-timeline-scroll");
    if (!enabled || !anchor || !scroller) return;
    // How far the timeline must scroll for the embed to sit at its fitted position.
    const distance = () =>
      anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - FIT_GAP_PX;
    let lastDistance = distance();
    // A wheel gesture runs from its first event until scrolling pauses; its later events and
    // momentum need not reach the page as wheel events.
    let gesture = false;
    let gestureEnd: ReturnType<typeof setTimeout> | undefined;
    const extendGesture = () => {
      clearTimeout(gestureEnd);
      gestureEnd = setTimeout(() => {
        gesture = false;
      }, DETENT_QUIET_MS);
    };
    let overflowBeforeLock = "";
    let lockedAt: number | null = null;
    let release: ReturnType<typeof setTimeout> | undefined;
    const unlock = () => {
      clearTimeout(release);
      if (lockedAt === null) return;
      lockedAt = null;
      scroller.style.overflowY = overflowBeforeLock;
      lastDistance = distance();
    };
    const scheduleRelease = () => {
      if (lockedAt === null) return;
      clearTimeout(release);
      const held = performance.now() - lockedAt;
      release = setTimeout(unlock, Math.max(DETENT_QUIET_MS, DETENT_MIN_HOLD_MS - held));
    };
    // Wheel input over an embed goes to its page, which passes on what it cannot scroll; the
    // timeline then scrolls with no wheel event of its own.
    const pointerOverEmbed = () => scroller.querySelector("[data-web-embed-hovered]") !== null;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      gesture = true;
      extendGesture();
      scheduleRelease();
    };
    const onScroll = () => {
      if (gesture) extendGesture();
      if (lockedAt !== null) return;
      const current = distance();
      const crossed =
        Math.abs(lastDistance) >= 1 &&
        (Math.abs(current) < 1 || Math.sign(current) !== Math.sign(lastDistance));
      lastDistance = current;
      if (!crossed || !(gesture || pointerOverEmbed())) return;
      lockedAt = performance.now();
      overflowBeforeLock = scroller.style.overflowY;
      scroller.style.overflowY = "hidden";
      scroller.scrollTop += current;
      lastDistance = 0;
      scheduleRelease();
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(gestureEnd);
      unlock();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [anchorRef, enabled]);
}
