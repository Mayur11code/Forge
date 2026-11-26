"use client";

import { useState, useTransition } from "react";
import { Role } from "@prisma/client";
import {
  UserPlus,
  Mail,
  Shield,
  Copy,
  Check,
  AlertCircle,
  Loader2,
  X,
  ExternalLink,
} from "lucide-react";
import { createInvitation } from "@/app/actions/Invitations/createInvitation";

interface Props {
  orgSlug: string;
}

export default function InviteMemberModal({ orgSlug }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(Role.MEMBER);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleClose = () => {
    setOpen(false);
    setEmail("");
    setInviteUrl(null);
    setError(null);
    setMessage(null);
    setCopied(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setInviteUrl(null);

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    startTransition(async () => {
      try {
        const result = await createInvitation({
          orgSlug,
          email: email.trim(),
          role,
        });

        setInviteUrl(result.inviteUrl);
        setEmailSent(result.emailSent);
        setMessage(result.message || null);
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to create invitation. Please try again."
        );
      }
    });
  };

  const handleCopy = () => {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {/* Trigger Button in Members Page */}
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-lg shadow-blue-600/20 transition-all"
      >
        <UserPlus className="w-4 h-4" />
        <span>Invite Team Member</span>
      </button>

      {/* Modal Dialog */}
      {open && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl text-zinc-100 space-y-5 animate-in zoom-in-95">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">Invite Team Member</h2>
                  <p className="text-xs text-zinc-400">
                    Send an invitation link via email to join your workspace.
                  </p>
                </div>
              </div>

              <button
                onClick={handleClose}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Error Banner */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs font-medium"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Success Output with Copy Link */}
            {inviteUrl ? (
              <div className="space-y-4 animate-in fade-in">
                <div
                  className={`p-3.5 rounded-xl border text-xs font-medium flex items-start gap-2.5 ${
                    emailSent
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                      : "bg-amber-500/10 border-amber-500/20 text-amber-400"
                  }`}
                >
                  <Check className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">
                      {emailSent
                        ? `Invitation email dispatched to ${email}`
                        : "Invitation link created"}
                    </p>
                    <p className="text-[11px] opacity-80 mt-0.5">{message}</p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-400">
                    Direct Invitation Link (valid 24h)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={inviteUrl}
                      className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl font-mono text-xs text-zinc-300 select-all"
                    />
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-semibold transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              /* Form */
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="invite-email"
                    className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
                  >
                    Recipient Email Address
                  </label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    autoFocus
                    placeholder="colleague@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isPending}
                    className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
                  />
                </div>

                <div>
                  <label
                    htmlFor="invite-role"
                    className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
                  >
                    Assigned Role
                  </label>
                  <select
                    id="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                    disabled={isPending}
                    className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
                  >
                    <option value={Role.MEMBER}>Member (Task & Project collaboration)</option>
                    <option value={Role.MANAGER}>Manager (Workflow authoring & management)</option>
                    <option value={Role.ADMIN}>Admin (Full organization management)</option>
                  </select>
                </div>

                <div className="pt-2 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isPending}
                    className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={isPending}
                    className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                  >
                    {isPending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Sending Invite...</span>
                      </>
                    ) : (
                      <>
                        <span>Send Invitation</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
