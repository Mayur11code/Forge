// src/components/workflow/RunWorkflowButton.tsx
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2 } from "lucide-react";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";

interface RunWorkflowButtonProps {
  workflowId: string;
  orgId: string;
  payload?: Record<string, any>; // Flexible injection
}

export default function RunWorkflowButton({
  workflowId,
  orgId,
  payload = {},
}: RunWorkflowButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleRun = () => {
    startTransition(async () => {
      // Blast the dynamic payload to the server action
      const result = await triggerWorkflowRun(workflowId, orgId, payload);

      if (result.success && result.redirectTo) {
        router.push(result.redirectTo);
      } else {
        alert(result.error); 
      }
    });
  };

  return (
    <button
      onClick={handleRun}
      disabled={isPending}
      className="flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 shadow-sm border border-zinc-800 transition-colors hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isPending ? (
        <Loader2 size={16} className="animate-spin text-zinc-400" />
      ) : (
        <Play size={14} className="fill-zinc-100" />
      )}
      {isPending ? "Starting Engine..." : "Test Workflow"}
    </button>
  );
}