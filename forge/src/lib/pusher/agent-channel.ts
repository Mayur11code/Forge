// src/lib/pusher/agent-channel.ts
//
// Pure parsing and channel-shape validation for the Pusher private-channel
// authorization endpoint.
//
// Kept free of I/O and `server-only` so the authorization contract can be
// tested directly.

/**
 * The only private channel shape this application authorizes.
 *
 * Must stay in sync with `publishAgentStatus`, which triggers on
 * `private-agent-${sessionId}`.
 */
export const AGENT_CHANNEL_PREFIX = "private-agent-";

export type PusherAuthRequest = {
  socketId: string;
  channelName: string;
};

/**
 * Pusher posts a form-encoded body:
 *   socket_id=123.456&channel_name=private-agent-abc
 *
 * The previous implementation split on "&" and "=" and took index [1], which
 * silently truncates any value containing "=" and produces `undefined` for
 * missing fields. Parse properly instead.
 */
export function parsePusherAuthBody(
  body: string,
): PusherAuthRequest | null {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  let params: URLSearchParams;

  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }

  const socketId = params.get("socket_id");
  const channelName = params.get("channel_name");

  if (!socketId || !channelName) {
    return null;
  }

  return { socketId, channelName };
}

/**
 * A session id is a Prisma cuid. We validate shape rather than exact length
 * so a future id strategy does not silently break authorization, but we still
 * reject anything that could not be an id (empty, whitespace, separators).
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Extract the agent session id from a private channel name.
 *
 * Returns null for anything that is not exactly `private-agent-<sessionId>`.
 * This rejects:
 *  - non-private channels (`agent-abc`)
 *  - the wrong prefix (`private-agentfoo-abc`, `private-evil-agent-abc`)
 *  - an empty session id (`private-agent-`)
 *  - private presence channels (`private-presence-abc`)
 *  - unrelated private channels
 */
export function extractAgentSessionId(
  channelName: string,
): string | null {
  if (typeof channelName !== "string") {
    return null;
  }

  if (!channelName.startsWith(AGENT_CHANNEL_PREFIX)) {
    return null;
  }

  const sessionId = channelName.slice(AGENT_CHANNEL_PREFIX.length);

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }

  return sessionId;
}
