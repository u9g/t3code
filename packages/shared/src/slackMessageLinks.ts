const LINK = String.raw`https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?[\w=.&%-]*\w)?`;
const WHOLE_LINK = new RegExp(`^${LINK}$`);

/** Every Slack message permalink in a run of text. Global, so match with `matchAll`. */
export const SLACK_MESSAGE_LINKS = new RegExp(LINK, "g");

export interface SlackMessageLink {
  readonly channel: string;
  readonly ts: string;
  /** Set on a reply's permalink: the thread it has to be read from. */
  readonly threadTs: string | null;
}

export function parseSlackMessageLink(url: string): SlackMessageLink | null {
  const match = WHOLE_LINK.exec(url);
  if (match === null) return null;
  return {
    channel: match[1]!,
    ts: `${match[2]}.${match[3]}`,
    threadTs: new URL(url).searchParams.get("thread_ts"),
  };
}
