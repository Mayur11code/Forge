// src/features/organizations/components/workflow/RunWorkflowButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";

interface RunWorkflowButtonProps {
  workflowId: string;
  orgId: string;
  label?: string;
}

export default function RunWorkflowButton({
  workflowId,
  orgId,
  label = "Test Workflow",
}: RunWorkflowButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const handleRun = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const result = await triggerWorkflowRun(workflowId, orgId);

      if (result.success) {
        toast.success("Workflow execution started.");
        router.push(result.redirectTo);
        return;
      }

      toast.error(result.error);
    } catch {
      toast.error("Failed to start workflow.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <button
      onClick={handleRun}
      disabled={submitting}
      className="flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-xs font-mono font-semibold text-zinc-200 transition-all hover:bg-white/[0.08] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
    >
      {submitting ? (
        <Loader2 size={14} className="animate-spin text-zinc-400" />
      ) : (
        <Play size={13} className="fill-zinc-200" />
      )}
      <span>{submitting ? "Starting Engine..." : label}</span>
    </button>
  );
}
