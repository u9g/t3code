import type { GitHubLinkPreview } from "@t3tools/contracts";

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/u;

function parsePullRequestUrl(url: string): { repository: string; number: number } | null {
  const match = PULL_REQUEST_URL.exec(url);
  return match === null ? null : { repository: match[1]!, number: Number(match[2]) };
}

/**
 * The pull request links of a paragraph that holds nothing else but the commas, spaces and line
 * breaks between them; null for any other paragraph.
 */
export function pullRequestStackMapUrls(paragraph: unknown): ReadonlyArray<string> | null {
  const urls = new Set<string>();
  // The chat keeps a link and the comma after it in one span.
  const collect = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const { type, tagName, value, properties, children } = node as Record<string, unknown>;
    if (type === "text") return typeof value === "string" && /^[\s,]*$/u.test(value);
    if (tagName === "br") return true;
    if (tagName === "p" || tagName === "span") {
      return Array.isArray(children) && children.every(collect);
    }
    const href = (properties as Record<string, unknown> | undefined)?.href;
    if (tagName !== "a" || typeof href !== "string" || parsePullRequestUrl(href) === null) {
      return false;
    }
    urls.add(href.replace(/\/$/u, ""));
    return true;
  };
  return collect(paragraph) && urls.size > 0 ? [...urls] : null;
}

export type PullRequestStackMapRow =
  | { readonly kind: "base"; readonly branch: string }
  | {
      readonly kind: "pull-request";
      readonly url: string;
      readonly number: number;
      /** 1 for a pull request on its group's base branch, one more per pull request under it. */
      readonly depth: number;
      /** False for a pull request the links only reach through their bases. */
      readonly linked: boolean;
      readonly preview: GitHubLinkPreview | null;
    };

export interface PullRequestStackMapGroup {
  readonly repository: string;
  readonly rows: ReadonlyArray<PullRequestStackMapRow>;
}

/**
 * Groups the linked pull requests by repository and orders each group as its stacks, base first.
 * `previews` holds what is read so far: a pull request without one is a row on its own, and every
 * linked pull request gets a row whatever the previews say.
 */
export function buildPullRequestStackMap(
  linked: ReadonlyArray<string>,
  previews: ReadonlyMap<string, GitHubLinkPreview | null>,
): ReadonlyArray<PullRequestStackMapGroup> {
  const parentOf = (url: string) => previews.get(url)?.pullRequest?.parentUrl ?? null;
  const urls = new Set(linked);
  for (const url of urls) {
    const parent = parentOf(url);
    if (parent !== null) urls.add(parent);
  }

  const byRepository = new Map<string, Array<{ url: string; number: number }>>();
  for (const url of urls) {
    const parsed = parsePullRequestUrl(url);
    if (parsed === null) continue;
    const members = byRepository.get(parsed.repository) ?? [];
    members.push({ url, number: parsed.number });
    byRepository.set(parsed.repository, members);
  }

  return [...byRepository].map(([repository, unsorted]) => {
    const members = unsorted.toSorted((a, b) => a.number - b.number);
    const rows: Array<PullRequestStackMapRow> = [];
    const placed = new Set<string>();
    let base: string | null = null;
    const place = (member: { url: string; number: number }, depth: number) => {
      if (placed.has(member.url)) return;
      placed.add(member.url);
      const preview = previews.get(member.url) ?? null;
      const branch = preview?.pullRequest?.baseBranch;
      if (depth === 1 && branch !== undefined && branch !== base) {
        base = branch;
        rows.push({ kind: "base", branch });
      }
      rows.push({
        kind: "pull-request",
        url: member.url,
        number: member.number,
        depth,
        linked: linked.includes(member.url),
        preview,
      });
      for (const child of members) {
        if (parentOf(child.url) === member.url) place(child, depth + 1);
      }
    };
    for (const member of members) {
      if (parentOf(member.url) === null) place(member, 1);
    }
    // Bases that name each other have no root; their pull requests still get rows.
    for (const member of members) place(member, 1);
    return { repository, rows };
  });
}
