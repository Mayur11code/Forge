/** @jest-environment jsdom */

// src/tests/agent/workflow-proposal-panel.test.tsx
//
// ASSIGNMENT 37.9.1 — INTEGRATION-LEVEL UI COVERAGE.
//
// The isolated `ProposalReviewCard` test proves the card works given props. This
// test proves the SURFACE that the product actually ships works end to end:
// input -> `POST /api/agent/init` -> poll `GET /api/agent/session/[sessionId]` ->
// mount the review card for a real-shaped pending-proposal response -> approve or
// decline through the real ingress path -> the server-confirmed terminal outcome
// is rendered. It also covers reload-resume, ownership failure and start failure,
// and that the AI page itself mounts the panel.

import "@testing-library/jest-dom";

import { fireEvent, render, screen, within } from "@testing-library/react";

import { WorkflowProposalPanel } from "@/features/organizations/components/ai/WorkflowProposalPanel";
import { buildProposalReviewModel } from "@/lib/ai/agent/services/proposal-review";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

jest.mock("@/features/organizations/components/ai/ChatWorkspace", () => ({
  ChatWorkspace: () => <div data-testid="chat-workspace" />,
}));

import DiagnosticsPage from "@/app/org/[orgId]/ai/page";

const SESSION_ID = "clxwsession111111111111";
const INTERACTION_ID = "clxwexec2222222222222";
const PROJECT_ID = "clxyz0000000000000000000a";
const ORG_SLUG = "acme";

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

const REVIEW = buildProposalReviewModel({
  proposal: PROPOSAL,
  reviewExpiresAt: new Date("2026-10-18T12:00:00.000Z"),
});

const REVIEW_WITH_CRITICALITY = buildProposalReviewModel({
  proposal: PROPOSAL,
  criticality: { kickoff: true, follow: false },
  reviewExpiresAt: new Date("2026-10-18T12:00:00.000Z"),
});

const CLARIFICATION = {
  interactionId: "clxclarexec33333333333",
  correlationId: "prop_corr_1234567890abcdef",
  toolName: "generateWorkflow",
  step: 2,
  fields: [
    {
      field: "steps.kickoff.inputs.projectId",
      reason: "task.create requires a project",
      question: "Which project should the task use?",
    },
  ],
};

function sessionPending() {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 3,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: null,
    pendingProposal: {
      interactionId: INTERACTION_ID,
      toolName: "generateWorkflow",
      state: "AWAITING_APPROVAL",
      expiresAt: "2026-10-18T12:00:00.000Z",
      review: REVIEW,
    },
    proposalOutcome: null,
  };
}

function sessionOutcome(state: "APPROVED" | "DECLINED" | "EXPIRED") {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 3,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: null,
    pendingProposal: null,
    proposalOutcome: {
      interactionId: INTERACTION_ID,
      state,
      decidedAt: "2026-10-18T11:00:00.000Z",
      review: REVIEW,
    },
  };
}

function sessionCriticality() {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 3,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: null,
    pendingProposal: {
      interactionId: INTERACTION_ID,
      toolName: "generateWorkflow",
      state: "AWAITING_CRITICALITY",
      expiresAt: null,
      review: REVIEW,
    },
    proposalOutcome: null,
  };
}

function sessionPendingAfterCriticality() {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 3,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: null,
    pendingProposal: {
      interactionId: INTERACTION_ID,
      toolName: "generateWorkflow",
      state: "AWAITING_APPROVAL",
      expiresAt: "2026-10-18T12:00:00.000Z",
      review: REVIEW_WITH_CRITICALITY,
    },
    proposalOutcome: null,
  };
}

function sessionClarification() {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 2,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: CLARIFICATION,
    pendingProposal: null,
    proposalOutcome: null,
  };
}

function sessionRunning() {
  return {
    sessionId: SESSION_ID,
    status: "RUNNING",
    currentStep: 3,
    finalResponse: null,
    error: null,
    terminalReason: null,
    clarification: null,
    pendingProposal: null,
    proposalOutcome: null,
  };
}

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = jest.fn();

type Route = {
  init?: () => Response;
  session?: Array<() => Response>;
  approve?: () => Response;
  decline?: () => Response;
  criticality?: () => Response;
  clarification?: () => Response;
};

function routeFetch(route: Route) {
  const sessionQueue = [...(route.session ?? [])];

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/agent/init")) {
      return route.init ? route.init() : json({ sessionId: SESSION_ID, status: "RUNNING" }, 202);
    }

    if (url.endsWith("/proposal-approval") && method === "POST") {
      return route.approve
        ? route.approve()
        : json({ sessionId: SESSION_ID, step: 3, state: "APPROVED", status: "ACCEPTED" });
    }

    if (url.endsWith("/proposal-decline") && method === "POST") {
      return route.decline
        ? route.decline()
        : json({ sessionId: SESSION_ID, step: 3, state: "DECLINED", status: "ACCEPTED" });
    }

    if (url.endsWith("/criticality") && method === "POST") {
      return route.criticality
        ? route.criticality()
        : json({ sessionId: SESSION_ID, step: 3, status: "ACCEPTED" });
    }

    if (url.endsWith("/clarification") && method === "POST") {
      return route.clarification
        ? route.clarification()
        : json({ sessionId: SESSION_ID, step: 2, status: "ACCEPTED" });
    }

    if (method === "GET" && url.includes("/api/agent/session/")) {
      const next = sessionQueue.shift();
      if (!next) throw new Error(`Unexpected extra session read: ${url}`);
      return next();
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
}

function submit(text: string) {
  fireEvent.change(screen.getByLabelText("Workflow request"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate workflow" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe("WorkflowProposalPanel — building and reviewing", () => {
  it("starts a session, mounts the review card on a pending proposal, and renders the approved outcome", async () => {
    fetchMock.mockImplementation(
      routeFetch({
        session: [() => json(sessionPending()), () => json(sessionOutcome("APPROVED"))],
      }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    submit("Onboard a client");

    // The session starts, the first read returns a pending proposal, and the
    // REAL review card is mounted for it.
    await screen.findByLabelText("Workflow proposal review");
    expect(screen.getByText("Onboard a client")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText(/This proposal was approved/);

    const approvalCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/proposal-approval"),
    );
    expect(approvalCall).toBeDefined();
    expect(approvalCall?.[0]).toBe(
      `/api/agent/session/${SESSION_ID}/proposal-approval`,
    );
    expect(approvalCall?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ interactionId: INTERACTION_ID }),
      }),
    );
  });

  it("declines a proposal through the decline endpoint and renders the declined outcome", async () => {
    fetchMock.mockImplementation(
      routeFetch({
        session: [() => json(sessionPending()), () => json(sessionOutcome("DECLINED"))],
      }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);
    submit("Onboard a client");

    await screen.findByLabelText("Workflow proposal review");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await screen.findByText(/You declined this proposal/);

    const declineCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/proposal-decline"),
    );
    expect(declineCall?.[0]).toBe(
      `/api/agent/session/${SESSION_ID}/proposal-decline`,
    );
    expect(declineCall?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ interactionId: INTERACTION_ID }),
      }),
    );
  });

  it("shows the expired outcome after a refresh, without presenting a decision", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json(sessionOutcome("EXPIRED"))] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    await screen.findByText(/before this proposal was decided/);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    // Reload resumed the stored session; it did NOT create a second one.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/agent/init")),
    ).toBe(false);
  });
});

describe("WorkflowProposalPanel — resilience", () => {
  it("resumes the stored session on mount without creating a new one", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json(sessionPending())] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    await screen.findByLabelText("Workflow proposal review");

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/agent/init")),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/agent/session/${SESSION_ID}`,
      ),
    ).toBe(true);
  });

  it("surfaces an ownership failure instead of an endless spinner", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json({ error: "Not found" }, 404)] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not available to your account",
    );
  });

  it("surfaces a failed start and does not fabricate a session", async () => {
    fetchMock.mockImplementation(
      routeFetch({ init: () => json({ error: "boom" }, 500) }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);
    submit("Onboard a client");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be started",
    );
    expect(
      window.localStorage.getItem(`forge:workflow-session:${ORG_SLUG}`),
    ).toBeNull();
  });

  it("does not poll in a loop after the review settles", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json(sessionPending())] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    await screen.findByLabelText("Workflow proposal review");

    // Give any (wrongly scheduled) follow-up read a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessionReads = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `/api/agent/session/${SESSION_ID}`,
    );
    expect(sessionReads).toHaveLength(1);
  });
});

describe("WorkflowProposalPanel — criticality decisions", () => {
  it("classifies every step, records criticality, and advances only after the authoritative reread", async () => {
    fetchMock.mockImplementation(
      routeFetch({
        session: [
          () => json(sessionCriticality()),
          () => json(sessionPendingAfterCriticality()),
        ],
      }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);
    submit("Onboard a client");

    await screen.findByLabelText("Workflow proposal review");

    // Every step is represented by its own explicit, initially unselected group.
    const kickoff = within(
      screen.getByRole("group", { name: "Criticality for step kickoff" }),
    );
    expect(kickoff.getByRole("radio", { name: "Critical" })).not.toBeChecked();
    fireEvent.click(kickoff.getByRole("radio", { name: "Critical" }));

    const follow = within(
      screen.getByRole("group", { name: "Criticality for step follow" }),
    );
    fireEvent.click(follow.getByRole("radio", { name: "Non-critical" }));

    // No approval path is fabricated while criticality is outstanding.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Record criticality" }));

    // The approve control appears only after the server-confirmed reread.
    await screen.findByRole("button", { name: "Approve" });

    const criticalityCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/criticality"),
    );
    expect(criticalityCall?.[0]).toBe(
      `/api/agent/session/${SESSION_ID}/criticality`,
    );

    const body = JSON.parse(
      (criticalityCall?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      interactionId: INTERACTION_ID,
      decisions: { kickoff: true, follow: false },
    });

    // Exactly two reads: the initial poll and the post-decision reread.
    const reads = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `/api/agent/session/${SESSION_ID}`,
    );
    expect(reads).toHaveLength(2);
  });

  it("keeps pending criticality through a reload without starting a second session", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json(sessionCriticality())] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    await screen.findByRole("group", { name: "Criticality for step kickoff" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/agent/init")),
    ).toBe(false);
  });
});

describe("WorkflowProposalPanel — clarification answers", () => {
  it("answers through the existing endpoint and resumes only after the authoritative reread", async () => {
    fetchMock.mockImplementation(
      routeFetch({
        session: [
          () => json(sessionClarification()),
          () => json(sessionRunning()),
        ],
      }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);
    submit("Onboard a client");

    await screen.findByLabelText("Clarification request");
    expect(
      screen.getByText("Which project should the task use?"),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Which project should the task use?"),
      { target: { value: PROJECT_ID } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    // Only the reread reporting a running session ends the clarification surface.
    await screen.findByText(/Generating a workflow proposal/);

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/clarification"),
    );
    expect(call?.[0]).toBe(`/api/agent/session/${SESSION_ID}/clarification`);

    const body = JSON.parse((call?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      interactionId: CLARIFICATION.interactionId,
      correlationId: CLARIFICATION.correlationId,
      answers: { "steps.kickoff.inputs.projectId": PROJECT_ID },
    });

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/agent/init"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the same pending clarification through a reload without a duplicate session", async () => {
    window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

    fetchMock.mockImplementation(
      routeFetch({ session: [() => json(sessionClarification())] }),
    );

    render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

    await screen.findByLabelText("Clarification request");
    expect(
      screen.getByText("Which project should the task use?"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/agent/init")),
    ).toBe(false);
  });
});

describe("WorkflowProposalPanel — terminal outcomes after refresh", () => {
  it.each(["APPROVED", "DECLINED", "EXPIRED"] as const)(
    "renders the %s outcome from authoritative state without a decision control",
    async (state) => {
      window.localStorage.setItem(`forge:workflow-session:${ORG_SLUG}`, SESSION_ID);

      fetchMock.mockImplementation(
        routeFetch({ session: [() => json(sessionOutcome(state))] }),
      );

      render(<WorkflowProposalPanel orgSlug={ORG_SLUG} />);

      const expected =
        state === "APPROVED"
          ? /This proposal was approved/
          : state === "DECLINED"
            ? /You declined this proposal/
            : /before this proposal was decided/;

      await screen.findByText(expected);
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith("/api/agent/init"),
        ),
      ).toBe(false);
    },
  );
});

describe("AI page composition", () => {
  it("mounts the workflow proposal panel alongside the chat workspace", async () => {
    const element = await DiagnosticsPage({
      params: Promise.resolve({ orgId: ORG_SLUG }),
    });

    render(element);

    expect(screen.getByLabelText("Workflow builder")).toBeInTheDocument();
    expect(screen.getByTestId("chat-workspace")).toBeInTheDocument();
  });
});
