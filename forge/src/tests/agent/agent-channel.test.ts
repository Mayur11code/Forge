// src/tests/agent/agent-channel.test.ts
//
// Channel-shape rules for the Pusher private-channel authorization endpoint.
// The previous implementation split the body on "&" and "=" and took index [1],
// which silently truncated values and produced `undefined` for missing fields.

import {
  extractAgentSessionId,
  parsePusherAuthBody,
  AGENT_CHANNEL_PREFIX,
} from "@/lib/pusher/agent-channel";

const SESSION_ID = "clx1234567890abcdefghijkl";

describe("parsePusherAuthBody", () => {
  it("parses a well-formed form body", () => {
    const parsed = parsePusherAuthBody(
      `socket_id=123.456&channel_name=${AGENT_CHANNEL_PREFIX}${SESSION_ID}`,
    );

    expect(parsed).toEqual({
      socketId: "123.456",
      channelName: `${AGENT_CHANNEL_PREFIX}${SESSION_ID}`,
    });
  });

  it("handles values containing '=' without truncating", () => {
    const parsed = parsePusherAuthBody(
      "socket_id=abc.def&channel_name=private-agent-abc=def",
    );

    expect(parsed?.channelName).toBe("private-agent-abc=def");
  });

  it("is order independent", () => {
    const parsed = parsePusherAuthBody(
      `channel_name=${AGENT_CHANNEL_PREFIX}${SESSION_ID}&socket_id=123.456`,
    );

    expect(parsed?.socketId).toBe("123.456");
  });

  it("rejects a body missing channel_name", () => {
    expect(parsePusherAuthBody("socket_id=123.456")).toBeNull();
  });

  it("rejects a body missing socket_id", () => {
    expect(parsePusherAuthBody("channel_name=private-agent-abc")).toBeNull();
  });

  it("rejects an empty body", () => {
    expect(parsePusherAuthBody("")).toBeNull();
  });
});

describe("extractAgentSessionId", () => {
  it("accepts the exact private agent channel", () => {
    expect(extractAgentSessionId(`${AGENT_CHANNEL_PREFIX}${SESSION_ID}`)).toBe(
      SESSION_ID,
    );
  });

  it("rejects a non-private channel", () => {
    expect(extractAgentSessionId(`agent-${SESSION_ID}`)).toBeNull();
    expect(extractAgentSessionId(SESSION_ID)).toBeNull();
  });

  it("rejects an unrelated private channel", () => {
    expect(extractAgentSessionId("private-presence-chat")).toBeNull();
    expect(extractAgentSessionId("private-notifications")).toBeNull();
    expect(extractAgentSessionId("private-project-abc")).toBeNull();
  });

  it("rejects a lookalike prefix", () => {
    expect(extractAgentSessionId(`private-agentevil-${SESSION_ID}`)).toBeNull();
    expect(extractAgentSessionId(`private-evil-agent-${SESSION_ID}`)).toBeNull();
    expect(extractAgentSessionId("private-Agents-abc")).toBeNull();
  });

  it("rejects an empty session id", () => {
    expect(extractAgentSessionId(AGENT_CHANNEL_PREFIX)).toBeNull();
    expect(extractAgentSessionId(`${AGENT_CHANNEL_PREFIX}   `)).toBeNull();
  });

  it("rejects separators that could not appear in a session id", () => {
    expect(extractAgentSessionId(`${AGENT_CHANNEL_PREFIX}abc/def`)).toBeNull();
    expect(extractAgentSessionId(`${AGENT_CHANNEL_PREFIX}abc?x=1`)).toBeNull();
    expect(extractAgentSessionId(`${AGENT_CHANNEL_PREFIX}../etc`)).toBeNull();
  });

  it("rejects a non-string", () => {
    expect(
      extractAgentSessionId(undefined as unknown as string),
    ).toBeNull();
  });
});
