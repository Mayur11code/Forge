"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ProjectsMeta = {
  latestCreatedAt: string | null;
  totalCount: number;
};

export default function ProjectsMetaRefresh({
  orgSlug,
  initialMeta,
}: {
  orgSlug: string;
  initialMeta: ProjectsMeta;
}) {
  const router = useRouter();

  // 🔑 baseline: what user has already seen
  const lastSeenRef = useRef<string | null>(
    initialMeta.latestCreatedAt
  );

  const [hasUpdates, setHasUpdates] = useState(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/org/${orgSlug}/projects/meta`,
          { cache: "no-store" }
        );

        if (!res.ok) return;

        const meta: ProjectsMeta = await res.json();

        if (
          meta.latestCreatedAt &&
          (!lastSeenRef.current ||
            new Date(meta.latestCreatedAt) >
              new Date(lastSeenRef.current))
        ) {
          setHasUpdates(true);
        }
      } catch {
        // silent polling failure
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [orgSlug]);

  if (!hasUpdates) return null;

  return (
    <div className="flex justify-center">
      <button
        onClick={() => {
          router.refresh();

          // ✅ reset baseline so button disappears
          lastSeenRef.current = new Date().toISOString();
          setHasUpdates(false);
        }}
        className="rounded-full border border-zinc-800 bg-zinc-900
                   px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-800"
      >
        New projects available
      </button>
    </div>
  );
}
