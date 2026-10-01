// src/core/chat/parser.mjs
// Chat command parser, ported verbatim from the pre-1.0
// worca-ui/server/integrations/commands/parser.js. Strips bot mentions
// (anywhere in the text) and handles Telegram's /command@botname suffix.

/**
 * One bot-mention token, in every form a shipped worker hands over verbatim:
 * `@name` (Telegram / plain text) and the Slack/Discord wire forms `<@U0123>`,
 * `<@!123>` (nickname), `<@&123>` (role) and `<@U0123|name>`. Teams' <at>…</at>
 * is stripped by its own worker. Exported so /direct slices msg.text with the
 * SAME definition — two mention grammars drifted once already.
 */
export const MENTION_TOKEN = String.raw`(?:@\S+|<@[!&]?[^\s>]+>)`;
const MENTION_RE = new RegExp(`^${MENTION_TOKEN}$`, 'i');

// Allow `-` inside command names (namespaced commands); hyphens must not lead
// or trail. Underscore-only commands still match.
const COMMAND_RE = /^\/([a-z_][a-z0-9_-]*)(?:@\S+)?$/i;

/**
 * @param {string} text
 * @returns {{ command: string, args: string[] } | null} null for non-commands
 */
export function parseCommand(text) {
  if (!text || !text.trim()) return null;

  const tokens = text.trim().split(/\s+/);
  const filtered = tokens.filter((t) => !MENTION_RE.test(t));
  if (filtered.length === 0) return null;

  const match = COMMAND_RE.exec(filtered[0]);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: filtered.slice(1),
  };
}
