import { SLACK_MESSAGE_LINKS } from "@t3tools/shared/slackMessageLinks";
import { WEB_EMBED_LINKS } from "@t3tools/shared/webEmbedLinks";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { SlackMessageEmbed } from "./SlackMessageEmbed";
import { WebPageEmbed } from "./WebPageEmbed";

// Shorter than in chat, so a pasted link does not push the composer off screen.
const COMPOSER_WEB_EMBED_HEIGHT = 280;

const EMBEDS: ReadonlyArray<readonly [RegExp, (url: string) => ReactNode]> = [
  [SLACK_MESSAGE_LINKS, (url) => <SlackMessageEmbed url={url} />],
  [WEB_EMBED_LINKS, (url) => <WebPageEmbed url={url} height={COMPOSER_WEB_EMBED_HEIGHT} />],
];

const LinkEmbedPluginKey = new PluginKey<DecorationSet>("composer-link-embeds");
const embedRoots = new WeakMap<Node, Root>();

function linkEmbedDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const [links, render] of EMBEDS) {
      for (const match of node.text!.matchAll(links)) {
        const url = match[0];
        decorations.push(
          Decoration.widget(
            pos + match.index + url.length,
            () => {
              const host = document.createElement("span");
              host.contentEditable = "false";
              const root = createRoot(host);
              root.render(<AppAtomRegistryProvider>{render(url)}</AppAtomRegistryProvider>);
              embedRoots.set(host, root);
              return host;
            },
            {
              // Keyed by link so edits elsewhere keep the mounted embed instead of redrawing it.
              key: url,
              side: 1,
              // ProseMirror can drop a widget inside a React commit, where a root cannot unmount.
              destroy: (host) => queueMicrotask(() => embedRoots.get(host)?.unmount()),
            },
          ),
        );
      }
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Shows what each Slack message, Claude artifact or Notion link in the prompt points at, below the
 * link; the prompt text is untouched.
 */
export const ComposerLinkEmbedExtension = Extension.create({
  name: "composer-link-embeds",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: LinkEmbedPluginKey,
        state: {
          init: (_, { doc }) => linkEmbedDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? linkEmbedDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => LinkEmbedPluginKey.getState(state) },
      }),
    ];
  },
});
