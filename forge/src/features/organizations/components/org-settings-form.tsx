"use client";

import { useState, useTransition } from "react";
import { updateOrgName } from "@/app/org/[orgId]/settings/actions";

interface OrgSettingsFormProps {
  orgId: string;
  initialName: string;
  role: "ADMIN" | "MEMBER" | "MANAGER";
}

export default function OrgSettingsForm({
  orgId,
  initialName,
  role,
}: OrgSettingsFormProps) {
  const [name, setName] = useState(initialName);
  const [isPending, startTransition] = useTransition();

  const isAdmin = role === "ADMIN";
  const isDisabled = !isAdmin || isPending;

  return (
    <div className="max-w-xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-lg font-medium text-gray-900">
          Organization Name
        </h2>
        <p className="text-sm text-gray-500">
          This name is displayed across your workspace and billing.
        </p>
      </div>

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(() => {
            updateOrgName(orgId, name);
          });
        }}
      >
        <div className="space-y-1">
          <label
            htmlFor="org-name"
            className="text-sm font-medium text-gray-700"
          >
            Name
          </label>

          <input
            id="org-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isDisabled}
            maxLength={50}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm
                       focus:border-black focus:outline-none focus:ring-1 focus:ring-black
                       disabled:cursor-not-allowed disabled:bg-gray-100"
          />
        </div>

        {!isAdmin && (
          <p className="text-sm text-amber-600">
            Only organization admins can change this setting.
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isDisabled}
            className="inline-flex items-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white
                       hover:bg-gray-900 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
