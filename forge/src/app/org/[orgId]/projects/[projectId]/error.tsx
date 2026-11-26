"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, RefreshCw, FolderGit2 } from "lucide-react";

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const orgId = typeof params?.orgId === "string" ? params.orgId : "";

  useEffect(() => {
    console.error("[PROJECT_BOUNDARY_ERROR]:", error);
  }, [error]);

  return (
    <div className="rounded-2xl border border-rose-500/30 bg-zinc-950/80 p-8 max-w-2xl mx-auto my-12 text-center shadow-2xl backdrop-blur-md">
      <div className="inline-flex p-3 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 mb-4">
        <AlertCircle className="w-6 h-6" />
      </div>

      <h2 className="text-2xl font-bold tracking-tight text-white mb-2">
        Error Loading Project Partition
      </h2>

      <p className="text-sm text-zinc-400 mb-6 font-light max-w-md mx-auto">
        Unable to resolve this project or its task collection. It may have been archived, relocated, or your membership permissions need to be refreshed.
      </p>

      {error?.message && (
        <div className="mb-6 p-3 bg-black/60 border border-zinc-800 rounded-lg text-left text-xs text-rose-300 font-mono break-all max-w-lg mx-auto">
          &gt; FAULT: {error.message}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={() => reset()}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black hover:bg-zinc-200 text-xs font-medium transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry Project Load
        </button>

        {orgId && (
          <Link
            href={`/org/${orgId}/projects`}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white text-xs font-mono transition-colors"
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            All Projects
          </Link>
        )}
      </div>
    </div>
  );
}
