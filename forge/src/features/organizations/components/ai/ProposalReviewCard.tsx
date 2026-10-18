"use client";

// src/features/organizations/components/ai/ProposalReviewCard.tsx
//
// ASSIGNMENT 37.9 — THE PROPOSAL REVIEW SURFACE.
//
// The human-facing card that presents a generated workflow proposal and lets the
// reviewer approve or decline it. It renders the model produced by
// `buildProposalReviewModel` verbatim and never re-derives anything from a
// second source, so what the reviewer sees is exactly what the server persisted
// and what an approval will bind to.
//
// The card is a leaf on purpose. It takes the session id, the interaction id,
// the proposal state and the review model as props, and it calls the two
// proposal-specific ingress routes. It does not fetch the session, hold a
// subscription, or know how it got there, so it can be embedded in whatever
// agent view exists (today: none - the agent subsystem is API-only) without
// dragging a transport decision into it.

import { memo, useState, type ReactNode } from "react";

import type { ProposalReviewModel } from "@/lib/ai/agent/services/proposal-review";

/** The proposal states this card can render. */
export type ProposalReviewState =
  | "AWAITING_CRITICALITY"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "DECLINED"
  | "EXPIRED";

export type ProposalReviewCardProps = {
  sessionId: string;
  interactionId: string;
  state: ProposalReviewState;
  review: ProposalReviewModel;
  /** Notified after the server accepts a decision, with the new state. */
  onDecided?: (state: "APPROVED" | "DECLINED", idempotent: boolean) => void;
  /**
   * Notified after the server accepts a criticality decision, so the mounting
   * surface can reread the AUTHORITATIVE session state. The card never advances
   * itself to AWAITING_APPROVAL: the server owns that transition, and it is only
   * reflected once a reread reports it.
   */
  onCriticalitySubmitted?: () => void;
};

type Decision = "approve" | "decline";

const ACTION_LABEL: Record<ProposalReviewState, string> = {
  AWAITING_CRITICALITY: "Awaiting criticality review",
  AWAITING_APPROVAL: "Awaiting your review",
  APPROVED: "Approved",
  DECLINED: "Declined",
  EXPIRED: "Review window closed",
};

function formatDeadline(iso: string | null): string | null {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString();
}

/**
 * One step row: its local ref, action, and dependencies.
 *
 * Inputs are shown as a compact JSON preview rather than a field-per-capability
 * form: the review surface presents what was proposed, it does not edit it.
 *
 * `control` is the optional per-step criticality choice, injected by the card
 * only while the proposal is awaiting criticality. Keeping it a slot means the
 * row's layout (what every step looks like) stays identical whether or not the
 * step is still open for a decision.
 */
const StepRow = memo(function StepRow({
  index,
  ref: stepRef,
  action,
  dependsOn,
  inputs,
  critical,
  control,
}: {
  index: number;
  ref: string;
  action: string;
  dependsOn: string[];
  inputs: Record<string, unknown>;
  critical: boolean | undefined;
  control?: ReactNode;
}) {
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-zinc-800 font-mono text-[10px] text-zinc-400">
            {index + 1}
          </span>
          <span className="truncate font-mono text-xs text-zinc-300">
            {stepRef}
          </span>
        </span>

        {critical !== undefined && (
          <span
            className={`shrink-0 rounded-md border px-2 py-0.5 text-[9px] uppercase tracking-widest ${
              critical
                ? "border-amber-800/60 bg-amber-950/40 text-amber-400"
                : "border-zinc-800 bg-zinc-900/50 text-zinc-500"
            }`}
          >
            {critical ? "Critical" : "Standard"}
          </span>
        )}
      </div>

      <p className="mt-2 text-[11px] text-zinc-400">
        <span className="text-zinc-600">Action </span>
        <span className="font-mono text-zinc-300">{action}</span>
      </p>

      <p className="mt-1 text-[11px] text-zinc-500">
        <span className="text-zinc-600">Depends on </span>
        {dependsOn.length > 0 ? dependsOn.join(", ") : "nothing"}
      </p>

      <pre className="mt-2 overflow-x-auto rounded-md bg-black/40 p-2 text-[10px] leading-relaxed text-zinc-500">
        {JSON.stringify(inputs, null, 2)}
      </pre>

      {control}
    </li>
  );
});

/**
 * The per-step critical/non-critical choice.
 *
 * A real radio group (fieldset + radios sharing a name) rather than two toggle
 * buttons, so the choice is keyboard-navigable and announced as a group with the
 * step it applies to. Neither option is preselected: an undecided step must be
 * visibly undecided, because the server rejects an incomplete decision set and
 * the UI must not imply a decision the human never made.
 */
const CriticalityChoice = memo(function CriticalityChoice({
  stepRef,
  value,
  disabled,
  onChange,
}: {
  stepRef: string;
  value: boolean | undefined;
  disabled: boolean;
  onChange: (critical: boolean) => void;
}) {
  return (
    <fieldset
      aria-label={`Criticality for step ${stepRef}`}
      className="mt-3 border-t border-zinc-800/70 pt-3"
    >
      <legend className="text-[10px] uppercase tracking-widest text-zinc-500">
        Rollback on failure?
      </legend>

      <div className="mt-2 flex items-center gap-5">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="radio"
            name={`criticality-${stepRef}`}
            value="critical"
            checked={value === true}
            disabled={disabled}
            onChange={() => onChange(true)}
            className="h-3.5 w-3.5 accent-amber-500"
          />
          Critical
        </label>

        <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="radio"
            name={`criticality-${stepRef}`}
            value="non-critical"
            checked={value === false}
            disabled={disabled}
            onChange={() => onChange(false)}
            className="h-3.5 w-3.5 accent-zinc-400"
          />
          Non-critical
        </label>
      </div>

      <p className="mt-1.5 text-[10px] text-zinc-600">
        Critical: a failure rolls the run back.
      </p>
    </fieldset>
  );
});

export const ProposalReviewCard = memo(function ProposalReviewCard({
  sessionId,
  interactionId,
  state,
  review,
  onDecided,
  onCriticalitySubmitted,
}: ProposalReviewCardProps) {
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<"APPROVED" | "DECLINED" | null>(null);

  // Per-step criticality draft, keyed by the proposal-local ref the SERVER
  // validates against. Absent means "not yet decided" - there is deliberately no
  // default, so the submit gate below can require a complete set.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [submittingCriticality, setSubmittingCriticality] = useState(false);
  // Set after a 2xx so the controls stay locked while the authoritative reread
  // is in flight. The card never flips its own state to AWAITING_APPROVAL.
  const [criticalityRecorded, setCriticalityRecorded] = useState(false);

  const effectiveState = decided ?? state;
  const isPending =
    effectiveState === "AWAITING_APPROVAL" ||
    effectiveState === "AWAITING_CRITICALITY";
  const canDecide = effectiveState === "AWAITING_APPROVAL";
  const awaitingCriticality = effectiveState === "AWAITING_CRITICALITY";

  const refs = review.steps.map((step) => step.ref);
  const complete = refs.every(
    (ref) => decisions[ref] === true || decisions[ref] === false,
  );
  const criticalityBusy = submittingCriticality || criticalityRecorded;

  const deadline = formatDeadline(review.reviewExpiresAt);

  async function submit(decision: Decision) {
    if (!canDecide || submitting) return;

    setSubmitting(decision);
    setError(null);

    try {
      // The approval route is `proposal-approval`; the decline route is
      // `proposal-decline`. They are not a single path with a suffix.
      const endpoint =
        decision === "approve" ? "proposal-approval" : "proposal-decline";

      const res = await fetch(`/api/agent/session/${sessionId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(body?.error ?? "The decision could not be recorded.");
        return;
      }

      const body = (await res.json()) as { idempotent?: boolean };
      const next = decision === "approve" ? "APPROVED" : "DECLINED";
      setDecided(next);
      onDecided?.(next, body.idempotent === true);
    } catch {
      setError("The decision could not be recorded.");
    } finally {
      setSubmitting(null);
    }
  }

  async function submitCriticality() {
    if (!awaitingCriticality || criticalityBusy) return;

    if (!complete) {
      setError("Decide every step before submitting.");
      return;
    }

    setSubmittingCriticality(true);
    setError(null);

    try {
      // The contract is exactly `{ interactionId, decisions }` keyed by the
      // proposal-local ref. No fingerprint, revision or other backend-owned
      // authority field is sent: the service recomputes the fingerprint itself
      // and binds the decision to the persisted proposal.
      const res = await fetch(
        `/api/agent/session/${sessionId}/criticality`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interactionId, decisions }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        setError(
          body?.error ?? "The criticality decisions could not be recorded.",
        );

        // A conflict means our view of the proposal is stale. Ask the surface to
        // reread authoritative state; remaining replays are idempotent.
        if (res.status === 409) {
          onCriticalitySubmitted?.();
        }
        return;
      }

      // Accepted. Do NOT fabricate AWAITING_APPROVAL - lock the controls and
      // let the authoritative reread report the new state.
      setCriticalityRecorded(true);
      onCriticalitySubmitted?.();
    } catch {
      setError("The criticality decisions could not be recorded.");
    } finally {
      setSubmittingCriticality(false);
    }
  }

  return (
    <section
      aria-label="Workflow proposal review"
      className="rounded-xl border border-zinc-800 bg-[#0a0a0a] p-5 shadow-2xl"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Workflow proposal
          </p>
          <h3 className="mt-1 truncate text-sm font-medium text-zinc-100">
            {review.name}
          </h3>
          {review.description && (
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              {review.description}
            </p>
          )}
        </div>

        <span
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[9px] uppercase tracking-widest ${
            isPending
              ? "border-zinc-700 text-zinc-300"
              : effectiveState === "APPROVED"
                ? "border-emerald-800/60 text-emerald-400"
                : "border-red-900/60 text-red-400"
          }`}
        >
          {ACTION_LABEL[effectiveState]}
        </span>
      </header>

      <p className="mt-4 text-[11px] uppercase tracking-widest text-zinc-500">
        {review.stepCount} {review.stepCount === 1 ? "step" : "steps"}
        {deadline && ` · review by ${deadline}`}
      </p>

      <ol className="mt-3 space-y-2">
        {review.steps.map((step, index) => (
          <StepRow
            key={step.ref}
            index={index}
            ref={step.ref}
            action={step.action}
            dependsOn={step.dependsOn}
            inputs={step.inputs}
            critical={review.criticality?.[step.ref]}
            control={
              awaitingCriticality ? (
                <CriticalityChoice
                  stepRef={step.ref}
                  value={decisions[step.ref]}
                  disabled={criticalityBusy}
                  onChange={(critical) =>
                    setDecisions((previous) => ({
                      ...previous,
                      [step.ref]: critical,
                    }))
                  }
                />
              ) : undefined
            }
          />
        ))}
      </ol>

      {review.clarification && (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
          <p className="text-[10px] uppercase tracking-widest text-zinc-500">
            Inputs you provided
          </p>
          <ul className="mt-2 space-y-1">
            {Object.entries(review.clarification).map(([key, value]) => (
              <li key={key} className="text-[11px] text-zinc-400">
                <span className="font-mono text-zinc-300">{key}</span>
                {": "}
                {typeof value === "string" ? value : JSON.stringify(value)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-xs text-red-400">
          {error}
        </p>
      )}

      {canDecide && !decided && (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => submit("approve")}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-200 px-4 text-xs font-semibold tracking-wide text-zinc-900 transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting === "approve" ? "Approving…" : "Approve"}
          </button>

          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => submit("decline")}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-700 px-4 text-xs font-semibold tracking-wide text-zinc-300 transition-all hover:border-zinc-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      )}

      {effectiveState === "DECLINED" && (
        <p className="mt-5 text-xs text-zinc-500">
          You declined this proposal. No workflow was created.
        </p>
      )}

      {effectiveState === "EXPIRED" && (
        <p className="mt-5 text-xs text-zinc-500">
          The review window closed before this proposal was decided.
        </p>
      )}

      {effectiveState === "APPROVED" && (
        <p className="mt-5 text-xs text-zinc-500">
          This proposal was approved.
        </p>
      )}

      {awaitingCriticality && (
        <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
          <p className="text-[11px] text-zinc-400">
            Decide per-step criticality before approving this proposal.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!complete || criticalityBusy}
              onClick={() => void submitCriticality()}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-200 px-4 text-xs font-semibold tracking-wide text-zinc-900 transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submittingCriticality ? "Submitting…" : "Record criticality"}
            </button>

            {!complete && (
              <span className="text-[10px] text-zinc-500">
                Classify every step to continue.
              </span>
            )}
          </div>

          {criticalityRecorded && (
            <p className="mt-2 text-[10px] text-zinc-500">
              Decisions recorded. Refreshing the session…
            </p>
          )}
        </div>
      )}
    </section>
  );
});
