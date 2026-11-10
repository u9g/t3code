// A Claude artifact (claude.ai/artifact/{id}, claude.ai/code/artifact/{uuid}, or an older public one).
const CLAUDE_ARTIFACT = String.raw`https:\/\/claude\.ai\/(?:code\/artifact|artifact|public\/artifacts)\/[\w-]+`;
// A Notion page or database: its path ends in the 32-hex block id, after an optional title slug.
const NOTION_PAGE = String.raw`https:\/\/(?:(?:www\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site)\/(?:[\w%.~-]+\/)*(?:[\w%.~-]*-)?[0-9a-f]{32}`;
const QUERY = String.raw`(?:\?[\w=.&%-]*\w)?`;
const LINK = String.raw`(?:${CLAUDE_ARTIFACT}|${NOTION_PAGE})${QUERY}`;
const WHOLE_LINK = new RegExp(`^${LINK}$`);

/** Every link in a run of text whose page is embedded in a webview. Global, so match with `matchAll`. */
export const WEB_EMBED_LINKS = new RegExp(LINK, "g");

export function isWebEmbedLink(url: string): boolean {
  return WHOLE_LINK.test(url);
}
