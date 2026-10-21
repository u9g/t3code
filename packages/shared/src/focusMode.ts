const URL_CHARS = "[^\\s<>()[\\]`\"']";
// Alternation order matters: an .mp4 markdown link is kept whole so local video paths stay clickable.
const FOCUS_LINK_PATTERN = new RegExp(
  [
    `!?\\[[^\\]]*\\]\\([^)\\s]+\\.mp4(?:[?#][^)\\s]*)?\\)`,
    `https?:\\/\\/${URL_CHARS}+\\.mp4(?:[?#]${URL_CHARS}*)?`,
    `https:\\/\\/github\\.com\\/${URL_CHARS}+`,
  ].join("|"),
  "giu",
);

/** Distinct github.com and .mp4 links in first-seen order; trailing sentence punctuation is not part of a URL. */
export function extractFocusLinks(text: string): ReadonlyArray<string> {
  const links = new Set<string>();
  for (const match of text.matchAll(FOCUS_LINK_PATTERN)) {
    links.add(match[0].endsWith(")") ? match[0] : match[0].replace(/[.,;:!?*_]+$/u, ""));
  }
  return [...links];
}

export function isFocusVideoLink(link: string): boolean {
  return /\.mp4(?:[?#)]|$)/iu.test(link);
}

/** The reply's first prose paragraph: headings, lists, quotes, tables and code blocks are skipped. */
export function extractFocusIntro(text: string): string | null {
  for (const block of text.split(/\n\s*\n/u)) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (/^(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\|)/u.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

export interface FocusSection {
  /** Null for the text before the first heading, which is always shown. */
  readonly heading: string | null;
  readonly body: string;
}

/** Splits markdown at ATX headings outside code fences; empty when the text has no headings. */
export function splitFocusSections(text: string): ReadonlyArray<FocusSection> {
  const sections: Array<{ heading: string | null; body: Array<string> }> = [
    { heading: null, body: [] },
  ];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const fenceMarker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMarker && (fence === null || fenceMarker.startsWith(fence))) {
      fence = fence === null ? fenceMarker : null;
    } else if (fence === null && /^ {0,3}#{1,6}\s/u.test(line)) {
      sections.push({ heading: line, body: [] });
      continue;
    }
    sections.at(-1)!.body.push(line);
  }
  if (sections.length === 1) return [];
  return sections
    .map(({ heading, body }) => ({ heading, body: body.join("\n").trim() }))
    .filter((section) => section.heading !== null || section.body.length > 0);
}
