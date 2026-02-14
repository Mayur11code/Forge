"use client";

import { useState, useTransition } from "react";
import { createInvitation } from "@/app/actions/createInvitation";

interface Props {
  orgSlug: string;
}

export default function InviteMemberModal({ orgSlug }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = () => {
    setError(null);
    setInviteUrl(null);

    startTransition(async () => {
      try {
        const result = await createInvitation({
          orgSlug,
          email,
          role,
        });

        setInviteUrl(result.inviteUrl);
      } catch (err: any) {
        setError(err.message || "Failed to create invitation.");
      }
    });
  };

  return (
    <>
      {/* Trigger */}
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg"
      >
        Invite Member
      </button>

      {/* Modal */}
      {open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 p-6 rounded-xl w-full max-w-md space-y-5">
            <h2 className="text-xl font-semibold">Invite Member</h2>

            {/* Email */}
            <div>
              <label className="text-sm text-zinc-400">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full mt-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg"
              />
            </div>

            {/* Role */}
            <div>
              <label className="text-sm text-zinc-400">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                className="w-full mt-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg"
              >
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>

            {/* Error */}
            {error && (
              <div className="text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* Invite URL Output */}
            {inviteUrl && (
              <div className="bg-zinc-800 p-3 rounded-lg text-sm break-all">
                <p className="text-green-400 mb-2">
                  Invitation Created:
                </p>
                <p>{inviteUrl}</p>

                <button
                  onClick={() => navigator.clipboard.writeText(inviteUrl)}
                  className="mt-2 text-blue-400 underline text-xs"
                >
                  Copy Link
                </button>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-2 text-zinc-400"
              >
                Cancel
              </button>

              <button
                onClick={handleSubmit}
                disabled={isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
              >
                {isPending ? "Creating..." : "Create Invite"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
