// src/features/organizations/components/workflow/RunWorkflowButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2 } from "lucide-react";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";

interface RunWorkflowButtonProps {
  workflowId: string;
  // The `[orgId]` URL segment, which is the organization *slug*. The server
  // action re-derives the tenant from it via `getOrgAccess`; nothing here is
  // trusted as authority.
  orgId: string;
}

/**
 * Explicit execution entry point for a persisted, materialized workflow.
 *
 * Assignment 37.12:
 *   * No fabricated trigger payload. The previous version shipped a hardcoded
 *     `mockProjectPayload` (`projectId: ...`), which invented runtime data that
 *     had nothing to do with the workflow being run. A generated,
 *     validator-clean workflow references no `{{trigger.outputs.*}}` field, so
 *     the correct call passes none; the server action validates any context that
 *     *is* supplied.
 *   * A local `submitting` guard prevents an accidental double-click from firing
 *     two start requests from this control. It is a UI affordance only: it does
 *     NOT make network retries idempotent. Two separate requests (a retry, a
 *     second tab, a replayed request) still create separate runs, which is the
 *     engine's existing, deliberate multiple-run policy.
 *   * The button reports *start*, never *completion*: a successful result gives a
 *     run id and a redirect to the authoritative run view; progress and terminal
 *     state come from persisted run state, not this component.
 */
export default function RunWorkflowButton({
  workflowId,
  orgId,
}: RunWorkflowButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const handleRun = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      // No trigger payload: generated workflows consume none, and the server
      // boundary refuses fabricated/arbitrary context anyway.
      const result = await triggerWorkflowRun(workflowId, orgId);

      if (result.success) {
        // Hand off to the existing run view. The run is created and the
        // evaluator has been seeded, but nothing here claims it has finished.
        router.push(result.redirectTo);
        return;
      }

      alert(result.error);
    } catch {
      // A thrown error (transport failure, action crash) must leave the control
      // retryable rather than stuck in a submitting state.
      alert("Failed to start workflow.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <button
      onClick={handleRun}
      disabled={submitting}
      className="flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 shadow-sm border border-zinc-800 transition-colors hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {submitting ? (
        <Loader2 size={16} className="animate-spin text-zinc-400" />
      ) : (
        <Play size={14} className="fill-zinc-100" />
      )}
      {submitting ? "Starting Engine..." : "Test Workflow"}
    </button>
  );
}
