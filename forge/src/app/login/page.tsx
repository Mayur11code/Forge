import { LoginFormComponent } from "./login-form";

export const metadata = {
  title: "Sign In | Forge",
  description: "Sign in to your Forge account to access your workflows, projects, and tasks.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ callbackUrl?: string; registered?: string; email?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-12">
      <LoginFormComponent
        callbackUrl={sp.callbackUrl}
        registered={sp.registered === "true"}
        defaultEmail={sp.email}
      />
    </div>
  );
}
