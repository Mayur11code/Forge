import "server-only";
import { db } from "@/lib/prisma/db";
import { CredentialPurpose } from "@prisma/client";

export interface OrganizationAiPolicy {
  orgId: string;
  purpose: CredentialPurpose;
  allowPlatformFallback: boolean;
  requiresByok: boolean;
  tierResolved: boolean;
  tierIdentifier: string | null;
  reason: string;
}

export interface PolicyResolverOptions {
  prismaClient?: typeof db;
}

/**
 * Authoritative Server-Only Entitlement Policy Resolver.
 *
 * Evaluates whether an organization is entitled to use Forge-owned platform
 * AI credentials when its own organization-scoped credentials are not configured.
 *
 * Rules:
 * 1. If an organization does not exist, fail-closed (no fallback).
 * 2. Unresolved / unknown billing plans NEVER silently grant platform fallback.
 * 3. Organizations with verified active subscriptions matching configured plans
 *    are entitled to platform fallback when customer keys are absent.
 * 4. Free, lapsed, or unsubscribed organizations require BYOK for AI operations.
 * 5. Can be explicitly overridden in non-production test environments via
 *    FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK="true".
 */
export async function resolveOrganizationAiPolicy(
  orgId: string,
  purpose: CredentialPurpose,
  options: PolicyResolverOptions = {}
): Promise<OrganizationAiPolicy> {
  const prismaClient = options.prismaClient || db;

  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    return {
      orgId,
      purpose,
      allowPlatformFallback: false,
      requiresByok: true,
      tierResolved: false,
      tierIdentifier: null,
      reason: "Missing or invalid organization identifier.",
    };
  }

  // Explicit development environment bypass - strictly restricted to development only.
  // An unset NODE_ENV, 'test', 'staging', or 'production' MUST NEVER activate it.
  if (
    process.env.NODE_ENV === "development" &&
    process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK === "true"
  ) {
    return {
      orgId,
      purpose,
      allowPlatformFallback: true,
      requiresByok: false,
      tierResolved: true,
      tierIdentifier: "DEV_OVERRIDE",
      reason: "Platform fallback permitted by FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK override.",
    };
  }

  const org = prismaClient.organization?.findUnique
    ? await prismaClient.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          planId: true,
          subscriptionStatus: true,
          razorpaySubscriptionId: true,
        },
      })
    : null;

  if (!org) {
    return {
      orgId,
      purpose,
      allowPlatformFallback: false,
      requiresByok: true,
      tierResolved: false,
      tierIdentifier: null,
      reason: `Organization '${orgId}' not found in database.`,
    };
  }

  const rawPlanId = process.env.RAZORPAY_PLAN_ID;
  const activePlanId =
    typeof rawPlanId === "string" && rawPlanId.trim().length > 0
      ? rawPlanId.trim()
      : null;

  // Active verified subscription: must have active status and match non-empty configured RAZORPAY_PLAN_ID
  if (
    activePlanId &&
    org.subscriptionStatus === "active" &&
    typeof org.planId === "string" &&
    org.planId.trim().length > 0 &&
    org.planId === activePlanId
  ) {
    return {
      orgId,
      purpose,
      allowPlatformFallback: true,
      requiresByok: false,
      tierResolved: true,
      tierIdentifier: org.planId,
      reason: "Active subscription entitled to Forge platform AI fallback.",
    };
  }

  // Known planId, but subscription is not active (canceled, past_due, etc.)
  if (org.planId && org.subscriptionStatus !== "active") {
    return {
      orgId,
      purpose,
      allowPlatformFallback: false,
      requiresByok: true,
      tierResolved: true,
      tierIdentifier: org.planId,
      reason: `Subscription status is '${org.subscriptionStatus || "inactive"}'; platform fallback denied.`,
    };
  }

  // Unsubscribed / Free organization
  if (!org.planId && !org.razorpaySubscriptionId) {
    return {
      orgId,
      purpose,
      allowPlatformFallback: false,
      requiresByok: true,
      tierResolved: true,
      tierIdentifier: "FREE",
      reason: "Unsubscribed organization has no platform AI credit entitlement; BYOK is required.",
    };
  }

  // Unknown or unmapped plan identifier: fail-closed per Section 6 requirements
  return {
    orgId,
    purpose,
    allowPlatformFallback: false,
    requiresByok: true,
    tierResolved: false,
    tierIdentifier: org.planId || "UNKNOWN",
    reason: `Unresolved plan identifier '${org.planId}'. No authoritative mapping to platform AI fallback exists.`,
  };
}
