"use client";

import { useState, useTransition } from "react";
import { UploadButton } from "@uploadthing/react";
import { updateUserProfile } from "@/app/actions/user/updateUserProfile";
import { useRouter } from "next/navigation";
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
  const [name, setName] = useState(user.name ?? "");
  const [image, setImage] = useState<string | null>(user.image);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const hasChanges =
  name !== user.name || image !== user.image;


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    startTransition(async () => {
      await updateUserProfile(user.id, name, image);
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 rounded-3xl border border-zinc-800 bg-zinc-900/30 p-8"
    >
      {/* Avatar */}
      <div className="space-y-3">
        <label className="text-sm text-zinc-400">
          Profile Image
        </label>

        <UploadButton<UploadRouter, "userAvatar">
          endpoint="userAvatar"
          input={{ userId: user.id, OrgId: user.slug }}
          onClientUploadComplete={(res) => {
            if (!res?.[0]) return;
            setImage(res[0].url);
            
          }}
          appearance={{
    button: "ut-ready:bg-blue-600 ut-uploading:bg-blue-400 ut-uploading:animate-pulse",
  }}
        />

        <div className="relative w-24 h-24">
  <div className="w-24 h-24 rounded-full overflow-hidden border border-zinc-800 bg-zinc-800">
    {image ? (
      <img
        src={image}
        alt="Avatar preview"
        className="w-full h-full object-cover animate-in fade-in duration-300"
      />
    ) : (
      <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm">
        No Image
      </div>
    )}
  </div>

  {image && image !== user.image && (
    <span className="absolute -bottom-2 -right-2 bg-yellow-500 text-black text-[10px] px-2 py-0.5 rounded-full font-semibold">
      Unsaved
    </span>
  )}
</div>

      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className="text-sm text-zinc-400">
          Full Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-white"
        />
      </div>

      {/* Email */}
      <div className="space-y-2">
        <label className="text-sm text-zinc-400">
          Email
        </label>
        <input
          value={user.email}
          disabled
          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2 text-zinc-500"
        />
      </div>

      <button
        type="submit"
        disabled={isPending || !hasChanges}
        className="px-6 py-2 bg-blue-600 rounded-xl text-white hover:bg-blue-500 transition"
      >
        Save Changes
      </button>
    </form>
  );
}
