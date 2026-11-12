import { shell, webFrameMain, type WebFrameMain } from "electron";
import * as Option from "effect/Option";

import { parseSafeExternalUrl } from "../electron/ElectronShell.ts";

/**
 * Turns every link click in a page embedded in chat (plain, ctrl/cmd, shift or middle) into a
 * window.open, so it reaches the guest's window-open handler, which opens it in the default browser.
 * In-page anchors and SPA routes would otherwise move the embed itself, or (new-tab clicks) go
 * nowhere. Runs in each frame: a Claude artifact draws its links inside a cross-origin frame.
 */
const INTERCEPT_LINKS = String.raw`(() => {
  if (window.__t3EmbedLinks) return;
  window.__t3EmbedLinks = true;
  const sameDocument = (url) =>
    url.hash !== "" && url.href.split("#")[0] === location.href.split("#")[0];
  const onClick = (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    const link = event
      .composedPath()
      .find((node) => node instanceof Element && node.matches("a[href], area[href]"));
    if (!link) return;
    let url;
    try {
      url = new URL(link.getAttribute("href"), document.baseURI);
    } catch {
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || sameDocument(url)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.open(url.href, "_blank", "noopener");
  };
  window.addEventListener("click", onClick, true);
  window.addEventListener("auxclick", onClick, true);
})()`;

const intercept = (frame: WebFrameMain | null | undefined) => {
  if (!frame || frame.isDestroyed()) return;
  frame.executeJavaScript(INTERCEPT_LINKS).catch(() => undefined);
};

const handled = new WeakSet<Electron.WebContents>();

/** Opens the links a chat page embed's page follows or opens in the default browser, not in the embed. */
export function openEmbedLinksExternally(guest: Electron.WebContents): void {
  if (handled.has(guest)) return;
  handled.add(guest);
  guest.setWindowOpenHandler(({ url }) => {
    const external = parseSafeExternalUrl(url);
    if (Option.isSome(external)) void shell.openExternal(external.value).catch(() => undefined);
    return { action: "deny" };
  });
  guest.on("did-frame-finish-load", (_event, _isMainFrame, processId, routingId) =>
    intercept(webFrameMain.fromId(processId, routingId)),
  );
  for (const frame of guest.mainFrame.framesInSubtree) intercept(frame);
}
