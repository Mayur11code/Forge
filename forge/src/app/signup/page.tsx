import { SignupFormComponent } from "./signup-form";

export const metadata = {
  title: "Create an Account | Forge",
  description: "Register for Forge to build, automate, and monitor your team workflows.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<{ inviteToken?: string; callbackUrl?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-12">
      <SignupFormComponent
        inviteToken={sp.inviteToken}
        callbackUrl={sp.callbackUrl}
      />
    </div>
  );
}
