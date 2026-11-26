"use client";

import { useState, useTransition } from "react";
import { UploadButton } from "@uploadthing/react";
import { useRouter } from "next/navigation";
import {
  User,
  Lock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  KeyRound,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  updateUserProfileAction,
  changePasswordAction,
} from "@/app/actions/user/profileActions";
import type { UploadRouter } from "@/app/api/uploadthing/core";

export default function ProfileForm({
  user,
}: {
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    slug: string;
  };
}) {
  const router = useRouter();

  // Profile Information State
  const [name, setName] = useState(user.name ?? "");
  const [image, setImage] = useState<string | null>(user.image);
  const [isProfilePending, startProfileTransition] = useTransition();
  const [profileFeedback, setProfileFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Password Change State
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [isPasswordPending, setIsPasswordPending] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const hasProfileChanges = name !== user.name || image !== user.image;

  // Handle Profile Update
  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setProfileFeedback(null);

    if (!name.trim()) {
      setProfileFeedback({
        type: "error",
        message: "Full name cannot be empty.",
      });
      return;
    }

    startProfileTransition(async () => {
      try {
        const result = await updateUserProfileAction(name.trim(), image);
        if (!result.success) {
          setProfileFeedback({
            type: "error",
            message: result.error || "Failed to update profile.",
          });
          return;
        }

        setProfileFeedback({
          type: "success",
          message: result.message || "Profile updated successfully.",
        });
        router.refresh();
      } catch (err) {
        setProfileFeedback({
          type: "error",
          message:
            err instanceof Error ? err.message : "An unexpected error occurred.",
        });
      }
    });
  };

  // Handle Password Change
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordFeedback(null);

    if (!currentPassword) {
      setPasswordFeedback({
        type: "error",
        message: "Please enter your current password.",
      });
      return;
    }

    if (newPassword.length < 8) {
      setPasswordFeedback({
        type: "error",
        message: "New password must be at least 8 characters long.",
      });
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setPasswordFeedback({
        type: "error",
        message: "New passwords do not match.",
      });
      return;
    }

    setIsPasswordPending(true);

    try {
      const result = await changePasswordAction(
        currentPassword,
        newPassword,
        confirmNewPassword
      );

      if (!result.success) {
        setPasswordFeedback({
          type: "error",
          message: result.error || "Failed to change password.",
        });
        setIsPasswordPending(false);
        return;
      }

      setPasswordFeedback({
        type: "success",
        message: result.message || "Password updated successfully.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (err) {
      setPasswordFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "An unexpected error occurred.",
      });
    } finally {
      setIsPasswordPending(false);
    }
  };

  return (
    <div className="space-y-10">
      {/* SECTION 1: Personal Profile */}
      <form
        onSubmit={handleProfileSubmit}
        className="space-y-6 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-8 shadow-xl"
      >
        <div className="border-b border-zinc-800/80 pb-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
            <User className="w-5 h-5 text-blue-400" />
            <span>Profile Information</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Update your display name and public avatar.
          </p>
        </div>

        {/* Profile Feedback */}
        {profileFeedback && (
          <div
            role={profileFeedback.type === "error" ? "alert" : "status"}
            className={`flex items-start gap-3 p-3.5 rounded-xl border text-sm animate-in fade-in ${
              profileFeedback.type === "error"
                ? "bg-red-500/10 border-red-500/20 text-red-400"
                : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
            }`}
          >
            {profileFeedback.type === "error" ? (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span className="font-medium">{profileFeedback.message}</span>
          </div>
        )}

        {/* Avatar Section */}
        <div className="space-y-3">
          <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Profile Avatar
          </label>

          <div className="flex items-center gap-6">
            <div className="relative w-20 h-20">
              <div className="w-20 h-20 rounded-full overflow-hidden border-2 border-zinc-700 bg-zinc-800 shadow-md">
                {image ? (
                  <img
                    src={image}
                    alt="Avatar preview"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-500 text-xs font-semibold uppercase">
                    {user.name?.charAt(0) || "U"}
                  </div>
                )}
              </div>

              {image && image !== user.image && (
                <span className="absolute -bottom-1 -right-1 bg-amber-400 text-black text-[9px] font-bold px-1.5 py-0.5 rounded-full shadow">
                  Unsaved
                </span>
              )}
            </div>

            <div className="space-y-1">
              <UploadButton<UploadRouter, "userAvatar">
                endpoint="userAvatar"
                input={{ userId: user.id, OrgId: user.slug }}
                onClientUploadComplete={(res) => {
                  if (!res?.[0]) return;
                  setImage(res[0].url);
                }}
                appearance={{
                  button:
                    "ut-ready:bg-zinc-800 ut-ready:hover:bg-zinc-700 ut-ready:border ut-ready:border-zinc-700 ut-ready:text-zinc-200 text-xs py-2 px-4 rounded-xl ut-uploading:bg-blue-600 ut-uploading:animate-pulse",
                }}
              />
              <p className="text-[11px] text-zinc-500">
                Recommended: Square PNG or JPG, max 4MB.
              </p>
            </div>
          </div>
        </div>

        {/* Name */}
        <div className="space-y-2">
          <label
            htmlFor="profile-name"
            className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
          >
            Full Name
          </label>
          <input
            id="profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isProfilePending}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
          />
        </div>

        {/* Email */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="profile-email"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
            >
              Email Address
            </label>
            <span className="text-[11px] text-zinc-500 font-mono">
              Primary Account Identity
            </span>
          </div>
          <input
            id="profile-email"
            value={user.email}
            disabled
            className="w-full bg-zinc-950/60 border border-zinc-850 rounded-xl px-4 py-2.5 text-zinc-400 text-sm cursor-not-allowed font-mono"
          />
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={isProfilePending || !hasProfileChanges}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded-xl shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            {isProfilePending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : (
              <span>Save Profile Changes</span>
            )}
          </button>
        </div>
      </form>

      {/* SECTION 2: Security & Password Update */}
      <form
        onSubmit={handlePasswordSubmit}
        className="space-y-6 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-8 shadow-xl"
      >
        <div className="border-b border-zinc-800/80 pb-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
            <KeyRound className="w-5 h-5 text-amber-400" />
            <span>Security & Password</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Ensure your account is using a secure password.
          </p>
        </div>

        {/* Password Feedback */}
        {passwordFeedback && (
          <div
            role={passwordFeedback.type === "error" ? "alert" : "status"}
            className={`flex items-start gap-3 p-3.5 rounded-xl border text-sm animate-in fade-in ${
              passwordFeedback.type === "error"
                ? "bg-red-500/10 border-red-500/20 text-red-400"
                : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
            }`}
          >
            {passwordFeedback.type === "error" ? (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span className="font-medium">{passwordFeedback.message}</span>
          </div>
        )}

        {/* Current Password */}
        <div className="space-y-2">
          <label
            htmlFor="current-password"
            className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
          >
            Current Password
          </label>
          <div className="relative">
            <input
              id="current-password"
              type={showCurrentPassword ? "text" : "password"}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={isPasswordPending}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 pr-11 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-1"
              aria-label={showCurrentPassword ? "Hide password" : "Show password"}
            >
              {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* New Password */}
        <div className="space-y-2">
          <label
            htmlFor="new-password"
            className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
          >
            New Password (min. 8 characters)
          </label>
          <div className="relative">
            <input
              id="new-password"
              type={showNewPassword ? "text" : "password"}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              disabled={isPasswordPending}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 pr-11 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-1"
              aria-label={showNewPassword ? "Hide new password" : "Show new password"}
            >
              {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Confirm New Password */}
        <div className="space-y-2">
          <label
            htmlFor="confirm-new-password"
            className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
          >
            Confirm New Password
          </label>
          <div className="relative">
            <input
              id="confirm-new-password"
              type={showConfirmNewPassword ? "text" : "password"}
              autoComplete="new-password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              disabled={isPasswordPending}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 pr-11 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowConfirmNewPassword(!showConfirmNewPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-1"
              aria-label={showConfirmNewPassword ? "Hide password" : "Show password"}
            >
              {showConfirmNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={
              isPasswordPending ||
              !currentPassword ||
              !newPassword ||
              !confirmNewPassword
            }
            className="px-6 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs rounded-xl shadow-lg shadow-amber-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            {isPasswordPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Updating Password...</span>
              </>
            ) : (
              <span>Update Password</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
