/** @jest-environment jsdom */

// src/tests/agent/proposal-review-card.test.tsx
//
// Assignment 37.9 — the human review surface.
//
// A client component: it renders the pure review model and calls the two
// proposal decision endpoints. jsdom + React Testing Library because the
// component's whole job is DOM + a POST; the underlying projection is covered
// separately by proposal-review-model.test.ts.

import "@testing-library/jest-dom";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ProposalReviewCard } from "@/features/organizations/components/ai/ProposalReviewCard";
import { buildProposalReviewModel } from "@/lib/ai/agent/services/proposal-review";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

const SESSION_ID = "clxsessioncardaaaaaaaaa";
const INTERACTION_ID = "clxexeccardbbbbbbbbbb";
const PROJECT_ID = "clxyz0000000000000000000a";

const PROPOSAL: WorkflowProposal = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

function model(overrides: Partial<Parameters<typeof buildProposalReviewModel>[0]> = {}) {
  return buildProposalReviewModel({ proposal: PROPOSAL, ...overrides });
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

function statusResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

function renderCard(
  props: Partial<React.ComponentProps<typeof ProposalReviewCard>> = {},
) {
  return render(
    <ProposalReviewCard
      sessionId={SESSION_ID}
      interactionId={INTERACTION_ID}
      state="AWAITING_APPROVAL"
      review={model()}
      {...props}
    />,
  );
}

describe("rendering the proposal", () => {
  it("shows the workflow name, description and step count", () => {
    renderCard();

    expect(screen.getByText("Onboard a client")).toBeInTheDocument();
    expect(screen.getByText("Kick off the onboarding.")).toBeInTheDocument();
    expect(screen.getByText(/2 steps/)).toBeInTheDocument();
  });

  it("renders each step's action and dependencies", () => {
    renderCard();

    expect(screen.getAllByText("task.create")).toHaveLength(2);
    // "kickoff" appears once as a step ref and once as `follow`'s dependency.
    expect(screen.getAllByText("kickoff")).toHaveLength(2);
  });

  it("badges critical and standard steps from the recorded decisions", () => {
    renderCard({
      review: model({ criticality: { kickoff: true, follow: false } }),
    });

    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Standard")).toBeInTheDocument();
  });

  it("lists the clarification answers the human provided", () => {
    renderCard({ review: model({ clarification: { project: "proj_1" } }) });

    expect(screen.getByText("Inputs you provided")).toBeInTheDocument();
    expect(document.body.textContent).toContain("proj_1");
  });
});

describe("able to decide", () => {
  it("offers Approve and Decline while awaiting approval", () => {
    renderCard();

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("POSTs an approval with only the interaction id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ idempotent: false }));
    const onDecided = jest.fn();

    renderCard({ onDecided });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("APPROVED", false));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agent/session/${SESSION_ID}/proposal-approval`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ interactionId: INTERACTION_ID }),
      }),
    );
  });

  it("POSTs a decline to the decline endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ idempotent: false }));
    const onDecided = jest.fn();

    renderCard({ onDecided });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("DECLINED", false));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agent/session/${SESSION_ID}/proposal-decline`,
      expect.anything(),
    );
  });

  it("surfaces the server error and keeps the buttons on a rejected decision", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "The review window closed." }, false),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The review window closed.",
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("reports a transport failure rather than hanging", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The decision could not be recorded.",
    );
  });
});

describe("criticality decisions", () => {
  function group(ref: string) {
    return within(
      screen.getByRole("group", { name: `Criticality for step ${ref}` }),
    );
  }

  function choose(ref: string, option: "Critical" | "Non-critical") {
    fireEvent.click(group(ref).getByRole("radio", { name: option }));
  }

  function renderCriticality(
    props: Partial<React.ComponentProps<typeof ProposalReviewCard>> = {},
  ) {
    return renderCard({ state: "AWAITING_CRITICALITY", ...props });
  }

  it("renders an explicit critical/non-critical choice for every proposed step", () => {
    renderCriticality();

    for (const ref of ["kickoff", "follow"]) {
      expect(
        screen.getByRole("group", { name: `Criticality for step ${ref}` }),
      ).toBeInTheDocument();
      expect(group(ref).getByRole("radio", { name: "Critical" })).toBeInTheDocument();
      expect(
        group(ref).getByRole("radio", { name: "Non-critical" }),
      ).toBeInTheDocument();
    }

    // No approval path is offered while criticality is outstanding.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("cannot submit an incomplete decision set", () => {
    renderCriticality();

    const submit = screen.getByRole("button", { name: "Record criticality" });
    expect(submit).toBeDisabled();

    choose("kickoff", "Critical");
    expect(submit).toBeDisabled();

    choose("follow", "Non-critical");
    expect(submit).toBeEnabled();
  });

  it("POSTs the exact interaction id and localRef-keyed decisions", async () => {
    fetchMock.mockResolvedValue(statusResponse({ idempotent: false }, 200));
    const onCriticalitySubmitted = jest.fn();

    renderCriticality({ onCriticalitySubmitted });
    choose("kickoff", "Critical");
    choose("follow", "Non-critical");
    fireEvent.click(screen.getByRole("button", { name: "Record criticality" }));

    await waitFor(() => expect(onCriticalitySubmitted).toHaveBeenCalled());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/criticality"),
    );
    expect(call?.[0]).toBe(`/api/agent/session/${SESSION_ID}/criticality`);

    const body = JSON.parse(
      (call?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    // Exactly the two backend-recognised keys; no fingerprint or revision.
    expect(body).toEqual({
      interactionId: INTERACTION_ID,
      decisions: { kickoff: true, follow: false },
    });
  });

  it("does not fabricate AWAITING_APPROVAL and asks for an authoritative reread", async () => {
    fetchMock.mockResolvedValue(statusResponse({ status: "ACCEPTED" }, 200));
    const onCriticalitySubmitted = jest.fn();

    renderCriticality({ onCriticalitySubmitted });
    choose("kickoff", "Critical");
    choose("follow", "Non-critical");
    fireEvent.click(screen.getByRole("button", { name: "Record criticality" }));

    expect(
      await screen.findByText(/Decisions recorded\. Refreshing/),
    ).toBeInTheDocument();
    expect(onCriticalitySubmitted).toHaveBeenCalledTimes(1);
    // The card stays on criticality; only the server reports the transition.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("surfaces a validation failure and keeps the controls usable", async () => {
    fetchMock.mockResolvedValue(
      statusResponse(
        { error: 'No criticality decision was supplied for step "follow".' },
        400,
      ),
    );
    const onCriticalitySubmitted = jest.fn();

    renderCriticality({ onCriticalitySubmitted });
    choose("kickoff", "Critical");
    choose("follow", "Non-critical");
    fireEvent.click(screen.getByRole("button", { name: "Record criticality" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'No criticality decision was supplied for step "follow".',
    );
    expect(onCriticalitySubmitted).not.toHaveBeenCalled();
    // The human can correct and retry; the choice is not lost.
    expect(
      group("kickoff").getByRole("radio", { name: "Critical" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Record criticality" })).toBeEnabled();
  });

  it("reconciles authoritative state on a conflict without resubmitting", async () => {
    fetchMock.mockResolvedValue(
      statusResponse(
        { error: "A newer proposal superseded this one.", code: "STALE_CRITICALITY" },
        409,
      ),
    );
    const onCriticalitySubmitted = jest.fn();

    renderCriticality({ onCriticalitySubmitted });
    choose("kickoff", "Critical");
    choose("follow", "Non-critical");
    fireEvent.click(screen.getByRole("button", { name: "Record criticality" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A newer proposal superseded this one.",
    );
    expect(onCriticalitySubmitted).toHaveBeenCalledTimes(1);
    // Reconcile means reread, not replay: exactly one decision POST was made.
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/criticality"),
      ),
    ).toHaveLength(1);
  });
});

describe("terminal outcomes", () => {
  it("shows the approved outcome and no decision buttons", () => {
    renderCard({ state: "APPROVED" });

    expect(screen.getByText(/This proposal was approved/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("shows the declined outcome and no decision buttons", () => {
    renderCard({ state: "DECLINED" });

    expect(screen.getByText(/You declined this proposal/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows the expired outcome and no decision buttons", () => {
    renderCard({ state: "EXPIRED" });

    expect(
      screen.getByText(/before this proposal was decided/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("does not offer approval while criticality is still outstanding", () => {
    renderCard({ state: "AWAITING_CRITICALITY" });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      screen.getByText(/Decide per-step criticality/),
    ).toBeInTheDocument();
  });
});
