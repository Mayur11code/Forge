export default function ExpiredInvitationPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-center p-6">
      <div className="bg-zinc-900 p-8 rounded-xl space-y-4 max-w-md">
        <h1 className="text-2xl font-semibold text-red-400">
          Invitation Expired
        </h1>
        <p className="text-zinc-400">
          This invitation link has expired. Please request a new one.
        </p>
      </div>
    </div>
  );
}
