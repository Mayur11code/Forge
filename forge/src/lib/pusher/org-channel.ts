// src/lib/pusher/org-channel.ts
//
// Pure organization-channel naming shared by the producer (email worker) and
// the subscriber (RealtimeListener).
//
// The organization channel is keyed by the persisted Organization.id, not the
// URL slug and not a user id. Event payloads carry the persisted id, and
// getOrgAccess returns it after resolving the slug, so both sides can agree on
// one identifier without adding another translation layer.
//
// Channels are prefixed with 'private-org-' to enforce Pusher server-side
// authorization (/api/pusher/auth) against verified organization membership.

export const ORG_CHANNEL_PREFIX = "private-org-";

const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the private organization channel name from a persisted organization id.
 *
 * Rejects empty or whitespace-padded values so a caller cannot silently
 * subscribe/publish to a different channel than the one it resolved.
 */
export function organizationChannelName(organizationId: string): string {
  if (typeof organizationId !== "string") {
    throw new Error("Organization channel requires a string organization id.");
  }

  const id = organizationId.trim();

  if (!id || id !== organizationId) {
    throw new Error(
      "Organization channel requires a non-empty organization id without surrounding whitespace.",
    );
  }

  return `${ORG_CHANNEL_PREFIX}${id}`;
}

/**
 * Extract the organization id from a private organization channel name.
 *
 * Returns null for anything that is not exactly `private-org-<orgId>`.
 */
export function extractOrganizationId(channelName: string): string | null {
  if (typeof channelName !== "string") {
    return null;
  }

  if (!channelName.startsWith(ORG_CHANNEL_PREFIX)) {
    return null;
  }

  const orgId = channelName.slice(ORG_CHANNEL_PREFIX.length);

  if (!ORG_ID_PATTERN.test(orgId)) {
    return null;
  }

  return orgId;
}
