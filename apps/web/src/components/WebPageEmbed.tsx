import type { EnvironmentId } from "@t3tools/contracts";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { useSeenInViewport } from "~/hooks/useSeenInViewport";
import { usePrimaryEnvironmentId } from "~/state/environments";

/**
 * The page a Claude artifact or Notion link points at, live in a webview below the link. It uses
 * the preview browser's default profile, so signing in there (or importing cookies from Chrome)
 * signs in every embed. Desktop only: the browser build has no webview, and the link stays a link.
 * Spans throughout: it sits inside paragraphs.
 */
export function WebPageEmbed({ url, height }: { url: string; height: number }) {
  const environmentId = usePrimaryEnvironmentId();
  const [viewportRef, seen] = useSeenInViewport();
  return (
    <span ref={viewportRef} className="block">
      {seen && environmentId !== null ? (
        <WebPageEmbedWebview url={url} height={height} environmentId={environmentId} />
      ) : null}
    </span>
  );
}

function WebPageEmbedWebview(props: { url: string; height: number; environmentId: EnvironmentId }) {
  const config = usePreviewWebviewConfig(props.environmentId);
  if (config === null) return null;
  return (
    <span
      className="my-1.5 block w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-background"
      style={{ height: props.height }}
    >
      <webview
        src={props.url}
        partition={config.partition}
        webpreferences={config.webPreferences}
        style={{ display: "flex", width: "100%", height: "100%" }}
      />
    </span>
  );
}
