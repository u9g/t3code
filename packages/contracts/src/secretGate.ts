import * as Schema from "effect/Schema";

/**
 * The secretgate Touch ID prompt on this environment's machine screen right
 * now. threadId is the thread whose agent asked for it, or null when no
 * prompt from a thread is up.
 */
export const SecretGatePrompt = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
});
export type SecretGatePrompt = typeof SecretGatePrompt.Type;
