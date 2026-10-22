// src/tests/security/org-channel.test.ts
//
// One channel name for the organization notification stream.
//
// Regression target: the email worker published to `org-${userId}` while the
// client subscribed to `org-${orgSlug}`. The two sides used different
// identifiers, so a correctly-authorized member never received the event. The
// channel is now derived from the persisted Organization.id on both sides.

import {
  ORG_CHANNEL_PREFIX,
  organizationChannelName,
} from "@/lib/pusher/org-channel";

const ORG_A = "clx_org_a";
const ORG_B = "clx_org_b";
const USER_ID = "clx_user_a";

describe("organizationChannelName", () => {
  it("uses the persisted organization id, never a user id", () => {
    expect(organizationChannelName(ORG_A)).toBe(`${ORG_CHANNEL_PREFIX}${ORG_A}`);
    expect(organizationChannelName(ORG_A)).not.toBe(
      `${ORG_CHANNEL_PREFIX}${USER_ID}`,
    );
  });

  it("keeps separate organizations on separate channels", () => {
    expect(organizationChannelName(ORG_A)).not.toBe(
      organizationChannelName(ORG_B),
    );
  });

  it("rejects an empty or whitespace-padded organization id", () => {
    expect(() => organizationChannelName("")).toThrow();
    expect(() => organizationChannelName("   ")).toThrow();
    expect(() => organizationChannelName(` ${ORG_A}`)).toThrow();
    expect(() => organizationChannelName(`${ORG_A} `)).toThrow();
  });
});
