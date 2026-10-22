// src/lib/pusher/org-channel.ts
//
// Pure organization-channel naming shared by the producer (email worker) and
// the subscriber (RealtimeListener).
//
// The organization channel is keyed by the persisted Organization.id, not the
// URL slug and not a user id. Event payloads carry the persisted id, and
// getOrgAccess returns it after resolving the slug, so both sides can agree on
// one identifier without adding another translation layer.

export const ORG_CHANNEL_PREFIX = "org-";

/**
 * Build the organization channel name from a persisted organization id.
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
