import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SlackMessagePreviewInput = Schema.Struct({ url: TrimmedNonEmptyString });
export type SlackMessagePreviewInput = typeof SlackMessagePreviewInput.Type;

/** What an embed shows for a Slack message permalink, read through the Slack app on the server's machine. */
export const SlackMessagePreview = Schema.Struct({
  /** `#channel`, or the other person in a direct message. */
  conversation: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  /** Plain text: mentions and links are already resolved to what Slack displays. */
  text: Schema.String,
  postedAt: IsoDateTime,
  replyCount: NonNegativeInt,
});
export type SlackMessagePreview = typeof SlackMessagePreview.Type;
