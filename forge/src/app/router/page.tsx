// src/app/dashboard/page.tsx
import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";

export default async function DashboardRouter() {
  const session = await auth();

  // 1. Security Check
  if (!session?.user) {
    redirect("/login");
  }

  // 2. The Logic: Redirect based on the slug we stored in the session
  if (session.user.orgSlug) {
    redirect(`/org/${session.user.orgSlug}/dashboard`);
  }

  // 3. Fallback: If they have no org, send them to onboarding or a default
  redirect("/onboarding");
}