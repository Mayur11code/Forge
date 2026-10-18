"use client";

// src/features/organizations/components/ai/ClarificationRequestCard.tsx
//
// ASSIGNMENT 37.6 — THE CLARIFICATION ANSWER SURFACE.
//
// A `generateWorkflow` run that hits a genuinely missing required input halts as
// `NEEDS_USER_INPUT` and parks the session. Until now nothing in the product
// could answer it: the endpoint existed, but the panel only listed the questions
// as dead text. This card turns the EXACT pending request the session read
// projects (`interactionId`, `correlationId`, `fields`) into a form.
//
// It is deliberately a leaf over that projection:
//   - It answers the existing 37.6 endpoint; it adds no second clarification
//     service and does not re-derive the pending ask from anything else.
//   - It submits the exact request shape the route accepts: `interactionId`,
//     `correlationId`, and an `answers` map keyed by each field's `field` path.
//   - It never fabricates success. A 2xx only asks the mounting surface to reread
//     authoritative session state; resume is reported by the session, not here.

import { memo, useState } from "react";

import type { MissingUserInputField } from "@/lib/ai/agent/tools/shared-output";

export type ClarificationRequestCardProps = {
  sessionId: string;
  /** The durable `AgentToolExecution.id` the answer must be bound to. */
  interactionId: string;
  /** The proposal-revision fingerprint; the secondary identity check. */
  correlationId: string | null;
  fields: MissingUserInputField[];
  /** Notified after the server accepts an answer, to trigger an authoritative reread. */
  onAnswered?: () => void;
};

/**
 * Error codes that mean our view of the pending request is stale, so the mount
 * should reread authoritative state rather than let the human replay the answer.
 * `SESSION_BUSY` is deliberately absent: it is retryable in place.
 */
const RECONCILE_CODES = new Set<string>([
  "STALE_CLARIFICATION",
  "NO_PENDING_CLARIFICATION",
  "CLARIFICATION_CONFLICT",
  "CLARIFICATION_NOT_APPLIED",
  "SESSION_NOT_RUNNING",
  "NOT_FOUND",
]);

/** True when a field offers grounded candidates and should render as a select. */
function hasChoices(field: MissingUserInputField): boolean {
  return (
    Array.isArray(field.candidateValues) && field.candidateValues.length > 0
  );
}

/** Human-readable option text for a candidate of unknown JSON shape. */
function formatCandidate(candidate: unknown): string {
  if (typeof candidate === "string") return candidate;
  if (candidate === null) return "null";
  if (typeof candidate === "object") return JSON.stringify(candidate);
  return String(candidate);
}

export const ClarificationRequestCard = memo(function ClarificationRequestCard({
  sessionId,
  interactionId,
  correlationId,
  fields,
  onAnswered,
}: ClarificationRequestCardProps) {
  // Draft answers, keyed by field path. For a select field the stored value is
  // the chosen option's index; for a free-text field it is the entered text.
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = submitting || submitted;
  const hasCorrelation = typeof correlationId === "string" && correlationId !== "";

  const complete =
    fields.length > 0 &&
    fields.every((field) => {
      const raw = values[field.field];

      if (raw === undefined) return false;
      if (hasChoices(field)) return raw !== "";

      return raw.trim() !== "";
    });

  function setValue(field: string, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (locked) return;

    if (!hasCorrelation) {
      setError(
        "This request is missing its correlation handle. Reload the session.",
      );
      return;
    }

    if (!complete) {
      setError("Answer every question before submitting.");
      return;
    }

    // Build the exact `answers` map the service validates: one entry per pending
    // field, keyed by the field path. A candidate-backed field sends the chosen
    // candidate value; a free-text field sends the trimmed text.
    const answers: Record<string, unknown> = {};

    for (const field of fields) {
      const raw = values[field.field] ?? "";

      if (hasChoices(field)) {
        const candidates = field.candidateValues as unknown[];
        answers[field.field] = candidates[Number(raw)];
      } else {
        answers[field.field] = raw.trim();
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/agent/session/${sessionId}/clarification`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interactionId, correlationId, answers }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        setError(body?.error ?? "The answer could not be submitted.");

        if (body?.code && RECONCILE_CODES.has(body.code)) {
          onAnswered?.();
        }
        return;
      }

      // Accepted. Do not claim the agent has resumed; reread authoritative state.
      setSubmitted(true);
      onAnswered?.();
    } catch {
      setError("The answer could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      aria-label="Clarification request"
      onSubmit={submit}
      className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3"
    >
      <p className="text-[10px] uppercase tracking-widest text-zinc-500">
        More information needed
      </p>
      <p className="mt-1 text-xs text-zinc-400">
        This request needs input before a workflow proposal can be generated.
      </p>

      <div className="mt-3 space-y-4">
        {fields.map((field) => {
          const raw = values[field.field] ?? "";
          const choices = hasChoices(field);

          return (
            <fieldset key={field.field} className="rounded-md border border-zinc-800/70 p-3">
              <legend className="px-1 text-[11px] font-medium text-zinc-200">
                {field.question}
              </legend>

              <p className="mt-1 text-[11px] text-zinc-500">{field.reason}</p>
              <p className="mt-1 font-mono text-[10px] text-zinc-600">
                {field.field}
              </p>

              {choices ? (
                <select
                  aria-label={field.question}
                  value={raw}
                  disabled={locked}
                  onChange={(event) =>
                    setValue(field.field, event.target.value)
                  }
                  className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-200 outline-none focus:border-zinc-700 disabled:cursor-not-allowed"
                >
                  <option value="" disabled>
                    Select an option…
                  </option>
                  {(field.candidateValues as unknown[]).map(
                    (candidate, index) => (
                      <option key={index} value={index}>
                        {formatCandidate(candidate)}
                      </option>
                    ),
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  aria-label={field.question}
                  value={raw}
                  disabled={locked}
                  onChange={(event) =>
                    setValue(field.field, event.target.value)
                  }
                  className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700 disabled:cursor-not-allowed"
                />
              )}
            </fieldset>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!complete || locked || !hasCorrelation}
        className="mt-3 inline-flex h-9 items-center justify-center rounded-lg bg-zinc-200 px-4 text-xs font-semibold tracking-wide text-zinc-900 transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Submitting…" : "Submit answer"}
      </button>

      {submitted && (
        <p className="mt-2 text-[10px] text-zinc-500">
          Answer submitted. Resuming the session…
        </p>
      )}
    </form>
  );
});
