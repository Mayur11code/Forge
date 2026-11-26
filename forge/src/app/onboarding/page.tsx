import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";
import { OnboardingFormComponent } from "./onboarding-form";

export const metadata = {
  title: "Create Organization | Forge",
  description: "Set up your organization workspace to begin collaborating and building workflows.",
};

export default async function OnboardingPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/onboarding");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-12">
      <OnboardingFormComponent />
    </div>
  );
}
