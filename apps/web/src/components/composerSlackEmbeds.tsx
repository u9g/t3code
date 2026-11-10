import { SLACK_MESSAGE_LINKS } from "@t3tools/shared/slackMessageLinks";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createRoot, type Root } from "react-dom/client";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { SlackMessageEmbed } from "./SlackMessageEmbed";

const SlackEmbedPluginKey = new PluginKey<DecorationSet>("composer-slack-embeds");
const embedRoots = new WeakMap<Node, Root>();

function slackEmbedDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const match of node.text!.matchAll(SLACK_MESSAGE_LINKS)) {
      const url = match[0];
      decorations.push(
        Decoration.widget(
          pos + match.index + url.length,
          () => {
            const host = document.createElement("span");
            host.contentEditable = "false";
            const root = createRoot(host);
            root.render(
              <AppAtomRegistryProvider>
                <SlackMessageEmbed url={url} />
              </AppAtomRegistryProvider>,
            );
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
  });
  return DecorationSet.create(doc, decorations);
}

/** Frames the message under each Slack permalink in the prompt; the prompt text is untouched. */
export const ComposerSlackEmbedExtension = Extension.create({
  name: "composer-slack-embeds",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: SlackEmbedPluginKey,
        state: {
          init: (_, { doc }) => slackEmbedDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? slackEmbedDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => SlackEmbedPluginKey.getState(state) },
      }),
    ];
  },
});
