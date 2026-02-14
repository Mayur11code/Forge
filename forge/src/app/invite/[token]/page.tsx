import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { notFound, redirect } from "next/navigation";
import { InvitationStatus } from "@prisma/client";
import RaceConditionPage from "@/features/organizations/components/invitation/Race";
import AlreadyMemberPage from "@/features/organizations/components/invitation/AlreadyMember";
import ExpiredInvitationPage from "@/features/organizations/components/invitation/ExpiredInvitation";
import AlreadyUsedPage from "@/features/organizations/components/invitation/AlreadyUsedInv";



interface PageProps {
  params: {
    token: string;
  };
}

export const dynamic = "force-dynamic"; // Ensure no caching

export default async function InvitePage({ params }: { params: Promise<PageProps> }) {
  const { token } = await params;

  // 1️⃣ Fetch Invitation
  const invitation = await db.invitation.findUnique({
    where: { token },
    include: {
      organization: {
        select: { id: true, slug: true, name: true },
      },
    },
  });

  // 2️⃣ Token Exists?
  if (!invitation) {
    return notFound();
  }

  // 3️⃣ Expired?
  if (invitation.expiresAt < new Date()) {
    // Optionally mark expired
    if (invitation.status === InvitationStatus.PENDING) {
    //   await db.invitation.update({
    //     where: { id: invitation.id },
    //     data: { status: InvitationStatus.EXPIRED },
    //   });

    await db.invitation.updateMany({
  where: {
    id: invitation.id,
    status: InvitationStatus.PENDING,
  },
  data: {
    status: InvitationStatus.EXPIRED,
  },

});
//IDEMPOTENT UPDATE: Only update if still PENDING, so if two requests come in at the same time, only one will mark it as expired, and the other will see it's already expired and won't change it again. This prevents
    }

    return (
      <ExpiredInvitationPage />
    );
  }

  // 4️⃣ Already Used?
  if (invitation.status !== InvitationStatus.PENDING) {
    return (
      <AlreadyUsedPage />
    );
  }

  // 5️⃣ Auth Check
  const session = await auth();

  if (!session?.user?.id) {
    // Redirect to login with callback
    redirect(`/login?callbackUrl=/invite/${token}`);
  }

  const userId = session.user.id;
  if (session.user.email !== invitation.email) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-center p-6">
      <h1 className="text-xl font-semibold text-red-400">
        Email Mismatch
      </h1>
      <p className="text-zinc-400">
        This invitation was sent to {invitation.email}.
        Please log in with the correct account.
      </p>
    </div>
  );
}


  // 6️⃣ Already Member Check
  const existingMembership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId,
        orgId: invitation.orgId,
      },
    },
  });

  if (existingMembership) {
    return (
      <AlreadyMemberPage orgSlug={invitation.organization.slug} />
    );
  }

  // 7️⃣ ACCEPT INVITATION (Transaction-Safe)
  try {
    await db.$transaction(async (tx) => {
      // Double-check status inside transaction (race safety)
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
    return (
      <RaceConditionPage />
    );
  }

  // 8️⃣ Redirect to Org Dashboard
  redirect(`/org/${invitation.organization.slug}`);
}
