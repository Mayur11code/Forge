import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { notFound, redirect } from "next/navigation";
import { InvitationStatus } from "@prisma/client";
import RaceConditionPage from "@/features/organizations/components/invitation/Race";
import AlreadyMemberPage from "@/features/organizations/components/invitation/AlreadyMember";
import ExpiredInvitationPage from "@/features/organizations/components/invitation/ExpiredInvitation";
import AlreadyUsedPage from "@/features/organizations/components/invitation/AlreadyUsedInv";

interface PageProps {
  token: string;
}

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<PageProps>;
}) {
  const { token } = await params;

  // 1. Fetch Invitation
  const invitation = await db.invitation.findUnique({
    where: { token },
    include: {
      organization: {
        select: { id: true, slug: true, name: true },
      },
    },
  });

  // 2. Token Exists?
  if (!invitation) {
    return notFound();
  }

  // 3. Expired Check
  if (invitation.expiresAt < new Date()) {
    if (invitation.status === InvitationStatus.PENDING) {
      await db.invitation.updateMany({
        where: {
          id: invitation.id,
          status: InvitationStatus.PENDING,
        },
        data: {
          status: InvitationStatus.EXPIRED,
        },
      });
    }

    return <ExpiredInvitationPage />;
  }

  // 4. Already Used Check
  if (invitation.status !== InvitationStatus.PENDING) {
    return <AlreadyUsedPage />;
  }

  // 5. Authentication Check
  const session = await auth();

  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/invite/${token}`);
  }

  const userId = session.user.id;
  const userEmail = session.user.email?.trim().toLowerCase();
  const inviteEmail = invitation.email.trim().toLowerCase();

  // 6. Recipient Email Mismatch Check (Case-insensitive)
  if (userEmail !== inviteEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-center p-6 text-zinc-100">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 space-y-4 shadow-2xl">
          <h1 className="text-xl font-semibold text-red-400">Email Mismatch</h1>
          <p className="text-zinc-400 text-sm">
            This invitation was sent to{" "}
            <strong className="text-white">{invitation.email}</strong>. You are currently signed in as{" "}
            <strong className="text-white">{session.user.email}</strong>.
          </p>
          <div className="pt-2">
            <a
              href={`/login?callbackUrl=/invite/${token}`}
              className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl transition-colors"
            >
              Sign In with Matching Account
            </a>
          </div>
        </div>
      </div>
    );
  }

  // 7. Already Member Check
  const existingMembership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId,
        orgId: invitation.orgId,
      },
    },
  });

  if (existingMembership) {
    return <AlreadyMemberPage orgSlug={invitation.organization.slug} />;
  }

  // 8. Atomic Transaction Acceptance
  try {
    await db.$transaction(async (tx) => {
      // Re-query status inside transaction with row lock / concurrency check
      const freshInvite = await tx.invitation.findUnique({
        where: { id: invitation.id },
      });

      if (!freshInvite || freshInvite.status !== InvitationStatus.PENDING) {
        throw new Error("Invitation already processed.");
      }

      // Create Membership
      await tx.membership.create({
        data: {
          userId,
          orgId: invitation.orgId,
          role: invitation.role,
        },
      });

      // Mark Invitation as ACCEPTED
      await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatus.ACCEPTED,
        },
      });
    });
  } catch (error) {
    return <RaceConditionPage />;
  }

  // 9. Redirect cleanly to Org Dashboard
  redirect(`/org/${invitation.organization.slug}/dashboard`);
}
