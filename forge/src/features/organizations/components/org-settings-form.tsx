"use client";

import { useState, useTransition } from "react";
import { updateOrgName } from "@/app/actions/updateOrg";
import { UploadButton } from "@uploadthing/react";
import type { UploadRouter } from "@/app/api/uploadthing/core";
import { Loader2, ShieldAlert, UploadCloud } from "lucide-react"; // Recommended icons

interface OrgSettingsFormProps {
  orgId: string;
  initialName: string;
  role: "ADMIN" | "MEMBER" | "MANAGER";
  initialLogo: string | null;
  orgSlug: string;
}

export default function OrgSettingsForm({
  orgId,
  initialName,
  role,
  initialLogo,
  orgSlug,
}: OrgSettingsFormProps) {
  const [name, setName] = useState(initialName);
  const [isPending, startTransition] = useTransition();
  const [logo, setLogo] = useState<string | null>(initialLogo);

  const isAdmin = role === "ADMIN";
  const isDisabled = !isAdmin || isPending;

  return (
    <div className="max-w-2xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      {/* Header */}
      <div className="border-b border-zinc-100 bg-zinc-50/50 p-6">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
          Organization Settings
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your organization's public identity and branding.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(() => {
            updateOrgName(orgId, name, logo);
          });
        }}
        className="divide-y divide-zinc-100"
      >
        {/* Organization Name Section */}
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <div>
            <label htmlFor="org-name" className="text-sm font-medium text-zinc-700">
              Display Name
            </label>
            <p className="text-xs text-zinc-500 mt-1">Visible in emails and invoices.</p>
          </div>
          <div className="sm:col-span-2">
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isDisabled}
              maxLength={50}
              placeholder="Enter organization name"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm transition-all
                         placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900
                         disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500"
            />
          </div>
        </div>

        {/* Logo Section */}
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium text-zinc-700">Organization Logo</label>
            <p className="text-xs text-zinc-500 mt-1">Square images work best.</p>
          </div>
          <div className="sm:col-span-2 flex items-center gap-6">
            <div className="relative group">
              {logo ? (
                <img
                  src={logo}
                  alt="Org Logo"
                  className="h-20 w-20 rounded-xl border border-zinc-200 object-cover shadow-sm transition-opacity group-hover:opacity-75"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 text-zinc-400">
                  <UploadCloud className="h-6 w-6" />
                </div>
              )}
            </div>

            <div className="flex-1">
              <UploadButton<UploadRouter, "orgLogo">
                endpoint="orgLogo"
                input={{ orgSlug }}
                appearance={{
                  button: "ut-ready:bg-zinc-900 ut-uploading:cursor-not-allowed rounded-md bg-zinc-800 px-4 py-2 text-sm after:bg-zinc-700",
                  allowedContent: "text-zinc-500 text-[10px] uppercase tracking-wider",
                }}
                onClientUploadComplete={(res) => {
                  if (!res?.[0]) return;
                  setLogo(res[0].url);
                }}
              />
            </div>
          </div>
        </div>

        {/* Permissions Alert & Footer */}
        <div className="bg-zinc-50/50 p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          {!isAdmin ? (
            <div className="flex items-center gap-2 text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full border border-amber-100">
              <ShieldAlert className="h-4 w-4" />
              <span className="text-xs font-medium">Read-only permissions</span>
            </div>
          ) : (
            <div /> // Spacer
          )}

          <button
            type="submit"
            disabled={isDisabled}
            className="flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-zinc-900 px-6 py-2.5 text-sm font-semibold text-white 
                       transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-300 shadow-sm"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isPending ? "Saving changes..." : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}