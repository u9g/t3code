// @effect-diagnostics globalDate:off globalTimers:off - Plain async helpers over Electron frames, outside an Effect runtime.
import { webContents, type WebFrameMain } from "electron";

/**
 * Where a page embedded in chat was scrolled, in every frame: a Claude artifact scrolls inside a
 * cross-origin frame, a Notion page inside an element, so neither the guest's window nor its main
 * frame alone holds it. Only the main process reaches every frame.
 */
interface FrameScroll {
  /** The frame's origin and path; a frame's query string can change on each load. */
  readonly frame: string;
  readonly scrolls: ReadonlyArray<{ path: string; classes: string; top: number; left: number }>;
}

// Each scrolled element, by its child-index path from the root ("" for the document) and, for when
// a fresh load lays the page out with other wrappers, by its classes.
const CAPTURE = String.raw`(() => {
  const root = document.scrollingElement;
  const out = [];
  if (root && (root.scrollTop > 0 || root.scrollLeft > 0)) {
    out.push({ path: "", classes: "", top: root.scrollTop, left: root.scrollLeft });
  }
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (el.scrollTop <= 0 && el.scrollLeft <= 0) continue;
    const parts = [];
    for (let node = el; node !== document.documentElement; node = node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    const classes = typeof el.className === "string" ? el.className.trim() : "";
    out.push({ path: parts.join("/"), classes, top: el.scrollTop, left: el.scrollLeft });
  }
  return out;
})()`;

// True once every element exists and has scrolled where it was.
const restoreScript = (scrolls: FrameScroll["scrolls"]) => String.raw`((scrolls) => {
  let done = true;
  const scrollable = (el) => el && el.scrollHeight > el.clientHeight;
  for (const { path, classes, top, left } of scrolls) {
    let el = document.scrollingElement;
    if (path !== "") {
      el = document.documentElement;
      for (const index of path.split("/")) el = el && el.children[Number(index)];
      if (!scrollable(el) && classes !== "") {
        const selector = "." + classes.split(/\s+/).map((name) => CSS.escape(name)).join(".");
        el = Array.from(document.querySelectorAll(selector)).find(scrollable) ?? el;
      }
    }
    if (!el) { done = false; continue; }
    el.scrollTop = top;
    el.scrollLeft = left;
    if (Math.abs(el.scrollTop - top) > 2) done = false;
  }
  return done;
})(${JSON.stringify(scrolls)})`;

const frameKey = (frame: WebFrameMain) => {
  try {
    const url = new URL(frame.url);
    return url.origin + url.pathname;
  } catch {
    return frame.url;
  }
};

/** The guest only when it is a webview the asking window hosts. */
const embedGuest = (webContentsId: number, hostId: number) => {
  const guest = webContents.fromId(webContentsId);
  return guest && !guest.isDestroyed() && guest.hostWebContents?.id === hostId ? guest : null;
};

async function capture(guest: Electron.WebContents): Promise<FrameScroll[]> {
  const frames = await Promise.all(
    guest.mainFrame.framesInSubtree.map(async (frame): Promise<FrameScroll | null> => {
      try {
        const scrolls = (await frame.executeJavaScript(CAPTURE)) as FrameScroll["scrolls"];
        return scrolls.length > 0 ? { frame: frameKey(frame), scrolls } : null;
      } catch {
        return null;
      }
    }),
  );
  return frames.filter((frame) => frame !== null);
}

const RESTORE_TIMEOUT_MS = 8_000;
const RESTORE_RETRY_MS = 250;

/**
 * Scrolls each frame back, retrying while the page (and frames it adds) loads and lays out.
 * Stops as soon as the user scrolls it themselves.
 */
async function restore(
  guest: Electron.WebContents,
  saved: FrameScroll[],
  interrupted: () => boolean,
): Promise<void> {
  let pending = saved;
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  while (pending.length > 0 && Date.now() < deadline && !guest.isDestroyed() && !interrupted()) {
    const frames = guest.mainFrame.framesInSubtree;
    const results = await Promise.all(
      pending.map(async (entry) => {
        const frame = frames.find((candidate) => frameKey(candidate) === entry.frame);
        if (!frame) return false;
        try {
          return (await frame.executeJavaScript(restoreScript(entry.scrolls))) === true;
        } catch {
          return false;
        }
      }),
    );
    pending = pending.filter((_, index) => !results[index]);
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, RESTORE_RETRY_MS));
  }
}

// Where each embedded link was last scrolled, for this run of the app.
const savedScrolls = new Map<string, FrameScroll[]>();
const tracked = new WeakSet<Electron.WebContents>();
// Input that can scroll; a swipe's momentum arrives as more wheel input.
const SCROLL_INPUT = new Set(["mouseWheel", "keyDown", "mouseUp", "gestureScrollEnd"]);
const CAPTURE_DEBOUNCE_MS = 400;
const CAPTURE_MAX_WAIT_MS = 1_500;

/**
 * Restores where the page at `key` was last scrolled, then keeps that up to date as the user
 * scrolls it. Captures follow the guest's own input, so they need nothing from the window when the
 * embed goes away.
 */
export function trackEmbedScroll(webContentsId: number, hostId: number, key: string): void {
  const guest = embedGuest(webContentsId, hostId);
  if (!guest || tracked.has(guest)) return;
  tracked.add(guest);
  let userScrolled = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let firstPending: number | null = null;
  const save = () => {
    clearTimeout(debounce);
    firstPending = null;
    if (guest.isDestroyed()) return;
    void capture(guest).then((frames) => savedScrolls.set(key, frames));
  };
  const onInput = (_event: Electron.Event, input: Electron.InputEvent) => {
    if (!SCROLL_INPUT.has(input.type)) return;
    userScrolled = true;
    const now = Date.now();
    firstPending ??= now;
    clearTimeout(debounce);
    debounce = setTimeout(
      save,
      Math.min(CAPTURE_DEBOUNCE_MS, Math.max(0, firstPending + CAPTURE_MAX_WAIT_MS - now)),
    );
  };
  guest.on("input-event", onInput);
  guest.once("destroyed", () => clearTimeout(debounce));
  const saved = savedScrolls.get(key);
  if (saved && saved.length > 0) void restore(guest, saved, () => userScrolled);
}
