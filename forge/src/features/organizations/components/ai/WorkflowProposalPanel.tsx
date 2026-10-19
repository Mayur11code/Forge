"use client";

// src/features/organizations/components/ai/WorkflowProposalPanel.tsx
//
// ASSIGNMENT 37.9.1 — THE WORKFLOW-BUILDING / REVIEW SURFACE.
//
// This closes the user-facing gap left by 37.9: `ProposalReviewCard` existed but
// nothing mounted it. The panel is a thin client over the EXISTING agent session
// APIs — it starts a session with `POST /api/agent/init`, then reads the
// authoritative session state with `GET /api/agent/session/[sessionId]` until the
// server parks the session on a human decision.
//
// It deliberately does NOT:
//   - use or replace the RAG `/api/chat` transport (that is a different feature);
//   - invent a second backend session system (there is exactly one: the agent
//     session created by `/api/agent/init`);
//   - generate proposal data, set criticality, or claim success before the server
//     confirms a decision (the card only advances after a 2xx).
//
// The panel is the only place a session is created, and it creates one only in
// response to a user submit. Every refresh is a GET, so repeated polling can
// never fork a second session. The active session id is persisted per org so a
// page reload resumes the SAME session instead of starting a new one.

import { useCallback, useEffect, useState } from "react";

import type { ProposalReviewModel } from "@/lib/ai/agent/services/proposal-review";
import type { MissingUserInputField } from "@/lib/ai/agent/tools/shared-output";
import type { CriticalityDecisions } from "@/lib/workflow-types/workflow-criticality";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

import { ClarificationRequestCard } from "./ClarificationRequestCard";
import {
  ProposalReviewCard,
  type ProposalReviewState,
} from "./ProposalReviewCard";
import { ProposalGraphPreview } from "./ProposalGraphPreview";

/** How often an active, non-terminal session is re-read. */
const POLL_INTERVAL_MS = 2500;

type PendingProposalView = {
  interactionId: string;
  toolName: string;
  state: ProposalReviewState;
  expiresAt: string | null;
  review: ProposalReviewModel | null;
  /**
   * Assignment 37.10: the canonical proposal and the human's COMPLETE
   * criticality decision set, both read from the same durable row. Both are
   * null when the row does not carry a renderable proposal, and
   * `approvedCriticality` is additionally null unless the server's authoritative
   * contract accepted the set for this exact revision — so the graph preview is
   * either given a complete, revision-bound set or not rendered at all.
   */
  proposal: WorkflowProposal | null;
  approvedCriticality: CriticalityDecisions | null;
};

type ProposalOutcomeView = {
  interactionId: string;
  state: ProposalReviewState;
  decidedAt: string;
  review: ProposalReviewModel | null;
  proposal: WorkflowProposal | null;
  approvedCriticality: CriticalityDecisions | null;
  /**
   * Assignment 37.11: the durable `Workflow.id` for a MATERIALIZED outcome,
   * resolved server-side from provenance and scoped to the authorized org. Null
   * for every other outcome, and also null when a MATERIALIZED row's workflow
   * could not be resolved (which the panel never presents as a success).
   */
  workflowId: string | null;
};

type ClarificationView = {
  interactionId: string;
  correlationId: string | null;
  toolName: string;
  step: number | null;
  fields: MissingUserInputField[];
};

/** The subset of the session-read contract this surface consumes. */
export type AgentSessionView = {
  sessionId: string;
  status: string;
  currentStep: number;
  finalResponse: string | null;
  error: string | null;
  terminalReason: string | null;
  clarification: ClarificationView | null;
  pendingProposal: PendingProposalView | null;
  proposalOutcome: ProposalOutcomeView | null;
};

function storageKey(orgSlug: string): string {
  return `forge:workflow-session:${orgSlug}`;
}

function readStoredSession(orgSlug: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(orgSlug));
  } catch {
    return null;
  }
}

function writeStoredSession(orgSlug: string, sessionId: string): void {
  try {
    window.localStorage.setItem(storageKey(orgSlug), sessionId);
  } catch {
    // Persistence is a convenience; a private-mode failure must not break the run.
  }
}

function clearStoredSession(orgSlug: string): void {
  try {
    window.localStorage.removeItem(storageKey(orgSlug));
  } catch {
    // Ignore.
  }
}

/**
 * A session is "settled" when there is nothing left for this surface to do, so
 * polling must stop: it is parked on a human decision (proposal or
 * clarification), the review is over, or the session itself is terminal.
 */
function isSettled(view: AgentSessionView): boolean {
  if (view.pendingProposal) return true;
  if (view.proposalOutcome) return true;
  if (view.clarification) return true;
  return view.status !== "RUNNING";
}

export function WorkflowProposalPanel({ orgSlug }: { orgSlug: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<AgentSessionView | null>(null);
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Resume the active session after a reload. Read in an effect, never in the
  // initializer, so the server-rendered markup (no localStorage) and the first
  // client render agree and hydration does not mismatch.
  useEffect(() => {
    const stored = readStoredSession(orgSlug);
    if (stored) {
      setSessionId(stored);
      setLoading(true);
    }
  }, [orgSlug]);

  const loadSession = useCallback(
    async (id: string): Promise<AgentSessionView> => {
      const res = await fetch(`/api/agent/session/${id}`, {
        cache: "no-store",
      });

      if (res.status === 401 || res.status === 404) {
        throw new Error(
          "This workflow session is not available to your account.",
        );
      }

      if (!res.ok) {
        throw new Error("The workflow session could not be loaded.");
      }

      return (await res.json()) as AgentSessionView;
    },
    [],
  );

  // Poll only while a session is active and unsettled. A `setTimeout` chain (not
  // a `setInterval`) means a slow response can never stack requests, and the
  // cleanup clears the pending timer on unmount or when the session changes.
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (id: string) => {
      try {
        const body = await loadSession(id);
        if (cancelled) return;
        setView(body);
        setError(null);
        setLoading(false);

        if (!isSettled(body)) {
          timer = setTimeout(() => void tick(id), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setError(
          err instanceof Error ? err.message : "Unable to load the session.",
        );
      }
    };

    setLoading(true);
    void tick(sessionId);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, nonce, loadSession]);

  async function startWorkflow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const message = request.trim();
    if (!message || starting) return;

    setStarting(true);
    setError(null);

    try {
      const res = await fetch("/api/agent/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug, message }),
      });

      if (res.status === 403) {
        throw new Error("You do not have access to this organization.");
      }

      if (!res.ok) {
        throw new Error("The workflow request could not be started.");
      }

      const body = (await res.json()) as { sessionId?: string };

      if (!body.sessionId) {
        throw new Error("The workflow request could not be started.");
      }

      writeStoredSession(orgSlug, body.sessionId);
      setView(null);
      setRequest("");
      setSessionId(body.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setStarting(false);
    }
  }

  function startOver() {
    clearStoredSession(orgSlug);
    setSessionId(null);
    setView(null);
    setError(null);
    setRequest("");
  }

  const pending = view?.pendingProposal ?? null;
  const outcome = view?.proposalOutcome ?? null;
  const clarification = view?.clarification ?? null;

  return (
    <section
      aria-label="Workflow builder"
      className="rounded-xl border border-zinc-800 bg-[#0a0a0a] p-5 shadow-2xl"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Workflow builder
          </p>
          <h2 className="mt-1 text-sm font-medium text-zinc-100">
            Describe a workflow, review the proposal
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
            The agent turns your request into a workflow proposal. Approve or
            decline it before anything is created.
          </p>
        </div>

        {sessionId && (
          <button
            type="button"
            onClick={startOver}
            className="shrink-0 rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-1 text-[10px] uppercase tracking-widest text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Start over
          </button>
        )}
      </header>

      {!sessionId && (
        <form onSubmit={startWorkflow} className="mt-5">
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={starting}
            rows={3}
            aria-label="Workflow request"
            placeholder="e.g. Onboard a new client: create a kickoff task, then a follow-up task."
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700 disabled:cursor-not-allowed"
          />

          <button
            type="submit"
            disabled={starting || !request.trim()}
            className="mt-3 inline-flex h-9 items-center justify-center rounded-lg bg-zinc-200 px-4 text-xs font-semibold tracking-wide text-zinc-900 transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {starting ? "Starting…" : "Generate workflow"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-4 text-xs text-red-400">
          {error}
        </p>
      )}

      {sessionId && (
        <div className="mt-5 space-y-4">
          <p className="text-[10px] uppercase tracking-widest text-zinc-600">
            {view
              ? `Session · ${view.status} · step ${view.currentStep}`
              : "Session · loading"}
          </p>

          {loading && !view && (
            <p className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
              Loading session…
            </p>
          )}

          {pending && pending.review && sessionId && (
            <ProposalReviewCard
              // Remount per authoritative state so a stale local decision (for a
              // superseded revision, or a criticality draft already recorded) can
              // never survive into the next state the server reports.
              key={`${pending.interactionId}:${pending.state}`}
              sessionId={sessionId}
              interactionId={pending.interactionId}
              state={pending.state}
              review={pending.review}
              onDecided={() => setNonce((value) => value + 1)}
              onCriticalitySubmitted={() => setNonce((value) => value + 1)}
            />
          )}

          {pending && !pending.review && (
            <p className="text-xs text-zinc-500">
              A proposal is parked for review, but it could not be rendered.
              Reload the session.
            </p>
          )}

          {/*
            Assignment 37.10 — the graph preview. Deliberately gated on ALL of:
            the pending state being `AWAITING_APPROVAL`, a canonical proposal,
            and the server-confirmed COMPLETE decision set. While criticality is
            still outstanding none of this renders, so no step is ever presented
            as definitively non-critical before the human has classified it, and
            the criticality controls stay exactly where they were.
          */}
          {pending &&
            pending.state === "AWAITING_APPROVAL" &&
            pending.proposal &&
            pending.approvedCriticality && (
              <ProposalGraphPreview
                proposal={pending.proposal}
                criticality={pending.approvedCriticality}
              />
            )}

          {!pending && outcome && outcome.review && sessionId && (
            <ProposalReviewCard
              sessionId={sessionId}
              interactionId={outcome.interactionId}
              state={outcome.state}
              review={outcome.review}
              workflowId={outcome.workflowId}
              orgSlug={orgSlug}
              onDecided={() => setNonce((value) => value + 1)}
              onMaterialized={() => setNonce((value) => value + 1)}
            />
          )}

          {!pending && outcome && !outcome.review && (
            <p className="text-xs text-zinc-500">
              The most recent proposal is {outcome.state.toLowerCase()}.
            </p>
          )}

          {/*
            Same projection for a settled review (approved, declined or expired).
            The terminal banner above still says what actually happened, and the
            preview's caption states that nothing has been created — an approved
            proposal materializes nothing until Assignment 37.11.
          */}
          {!pending &&
            outcome &&
            outcome.proposal &&
            outcome.approvedCriticality && (
              <ProposalGraphPreview
                proposal={outcome.proposal}
                criticality={outcome.approvedCriticality}
              />
            )}

          {!pending && !outcome && clarification && sessionId && (
            <ClarificationRequestCard
              key={`${clarification.interactionId}:${clarification.correlationId ?? ""}`}
              sessionId={sessionId}
              interactionId={clarification.interactionId}
              correlationId={clarification.correlationId}
              fields={clarification.fields}
              onAnswered={() => setNonce((value) => value + 1)}
            />
          )}

          {!pending &&
            !outcome &&
            !clarification &&
            view &&
            view.status === "RUNNING" && (
              <p className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
                Generating a workflow proposal…
              </p>
            )}

          {!pending &&
            !outcome &&
            !clarification &&
            view &&
            view.status !== "RUNNING" && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
                <p className="text-xs text-zinc-400">
                  Session {view.status.toLowerCase()}
                  {view.terminalReason ? ` · ${view.terminalReason}` : ""}.
                </p>
                {view.finalResponse && (
                  <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-500">
                    {view.finalResponse}
                  </p>
                )}
              </div>
            )}
        </div>
      )}
    </section>
  );
}
