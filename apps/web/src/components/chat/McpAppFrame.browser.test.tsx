import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";

// Reports the height it is told to. Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout.
const APP_HTML = `<script>
let answered = false;
addEventListener("message", (event) => {
  const message = event.data;
  if (typeof message === "string" && message.startsWith("height:")) {
    const height = Number(message.slice("height:".length));
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } }, "*");
  } else if (message === "close") {
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
  } else if (message?.method === "ui/resource-teardown" && !answered) {
    answered = true;
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  }
});
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
</script>`;

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(APP_HTML)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

import { McpAppFrame } from "./McpAppFrame";

const nextInitializedFrom = () =>
  new Promise<MessageEventSource>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.source === null || event.data?.method !== "ui/notifications/initialized") return;
      window.removeEventListener("message", listen);
      resolve(event.source);
    };
    window.addEventListener("message", listen);
  });

const renderDemoApp = () =>
  render(
    <McpAppFrame
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make("thread")}
      conversationThreadId={ThreadId.make("thread")}
      itemId={TurnItemId.make("item")}
      revision="1"
      app={{
        attachmentId: "attachment",
        server: "Demo",
        tool: "show",
        resourceUri: "ui://demo/app",
      }}
      onSendMessage={undefined}
    />,
  );

describe("McpAppFrame", () => {
  it("takes no space while the app reports a height of 0, and returns when it reports one", async () => {
    const initialized = nextInitializedFrom();
    await using screen = await renderDemoApp();
    const app = (await initialized) as Window;
    const box = () => screen.container.querySelector<HTMLElement>("[style*='height']")!;

    app.postMessage("height:0", "*");
    await expect.poll(() => box().getBoundingClientRect().height).toBe(0);
    expect(box().hasAttribute("data-mcp-app-hidden")).toBe(true);

    app.postMessage("height:200", "*");
    await expect.poll(() => box().getBoundingClientRect().height).toBe(200);
    expect(box().hasAttribute("data-mcp-app-hidden")).toBe(false);
  });

  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    const firstInitialized = nextInitializedFrom();
    await using screen = await renderDemoApp();
    const firstApp = await firstInitialized;
    using _timers = fakeTimers();

    (firstApp as Window).postMessage("close", "*");
    await userEvent.click(screen.getByRole("button", { name: "Show app" }));
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Show app" }).query()).toBeNull();
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();
  });
});
