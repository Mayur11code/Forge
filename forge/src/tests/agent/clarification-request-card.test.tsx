/** @jest-environment jsdom */

// src/tests/agent/clarification-request-card.test.tsx
//
// Assignment 37.6 — the human answer surface.
//
// The card is a client leaf over the pending-clarification projection the
// session read produces. These tests are deterministic component coverage:
// fetch is mocked, so this proves WHAT the browser submits and HOW it reacts,
// not that the service resumes the loop. The service/route and the connected
// continuation are covered separately by clarification-route.test.ts,
// missing-input-protocol.test.ts and clarification-continuation.test.ts.

import "@testing-library/jest-dom";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ClarificationRequestCard } from "@/features/organizations/components/ai/ClarificationRequestCard";
import type { MissingUserInputField } from "@/lib/ai/agent/tools/shared-output";

const SESSION_ID = "clxsessionclaraaaaaaaa";
const INTERACTION_ID = "clxexecclarcccccccccc";
const CORRELATION_ID = "prop_corr_1234567890abcdef";
const PROJECT_ID = "clxyz0000000000000000000a";

const PROJECT_FIELD: MissingUserInputField = {
  field: "steps.kickoff.inputs.projectId",
  reason: "task.create requires a project",
  question: "Which project should the task use?",
};

const TITLE_FIELD: MissingUserInputField = {
  field: "steps.kickoff.inputs.title",
  reason: "task.create requires a title",
  question: "What should the task be called?",
};

const ASSIGNEE_FIELD: MissingUserInputField = {
  field: "steps.kickoff.inputs.assigneeId",
  reason: "task.create requires an assignee",
  question: "Who should own it?",
  candidateValues: ["user_a", "user_b"],
};

const fetchMock = jest.fn();

function statusResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

function renderCard(
  props: Partial<React.ComponentProps<typeof ClarificationRequestCard>> = {},
) {
  return render(
    <ClarificationRequestCard
      sessionId={SESSION_ID}
      interactionId={INTERACTION_ID}
      correlationId={CORRELATION_ID}
      fields={[PROJECT_FIELD, TITLE_FIELD]}
      {...props}
    />,
  );
}

function type(question: string, value: string) {
  fireEvent.change(screen.getByLabelText(question), {
    target: { value },
  });
}

function submitButton() {
  return screen.getByRole("button", { name: "Submit answer" });
}

describe("rendering the pending clarification", () => {
  it("renders every question from the server projection, with its reason and path", () => {
    renderCard();

    expect(screen.getByText("Which project should the task use?")).toBeInTheDocument();
    expect(screen.getByText("What should the task be called?")).toBeInTheDocument();
    expect(screen.getByText("task.create requires a project")).toBeInTheDocument();
    expect(
      screen.getByText("steps.kickoff.inputs.projectId"),
    ).toBeInTheDocument();

    expect(screen.getByLabelText("Which project should the task use?")).toBeInTheDocument();
    expect(screen.getByLabelText("What should the task be called?")).toBeInTheDocument();
  });

  it("renders a select for a field with grounded candidates", () => {
    renderCard({ fields: [ASSIGNEE_FIELD] });

    const select = screen.getByLabelText("Who should own it?");
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "user_a" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "user_b" })).toBeInTheDocument();
  });
});

describe("required answer validation", () => {
  it("does not allow submission until every field is answered", () => {
    renderCard();

    expect(submitButton()).toBeDisabled();

    type("Which project should the task use?", PROJECT_ID);
    expect(submitButton()).toBeDisabled();

    type("What should the task be called?", "Kick off");
    expect(submitButton()).toBeEnabled();
  });

  it("treats whitespace as unanswered", () => {
    renderCard({ fields: [PROJECT_FIELD] });

    type("Which project should the task use?", "   ");
    expect(submitButton()).toBeDisabled();
  });
});

describe("submitting the answer", () => {
  it("POSTs the exact endpoint, identity handles and answers map", async () => {
    fetchMock.mockResolvedValue(statusResponse({ status: "ACCEPTED" }, 200));
    const onAnswered = jest.fn();

    renderCard({ onAnswered });
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onAnswered).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agent/session/${SESSION_ID}/clarification`,
      expect.objectContaining({ method: "POST" }),
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body).toEqual({
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: {
        "steps.kickoff.inputs.projectId": PROJECT_ID,
        "steps.kickoff.inputs.title": "Kick off",
      },
    });
  });

  it("sends the chosen candidate value for a select field", async () => {
    fetchMock.mockResolvedValue(statusResponse({ status: "ACCEPTED" }, 200));

    renderCard({ fields: [ASSIGNEE_FIELD] });
    fireEvent.change(screen.getByLabelText("Who should own it?"), {
      target: { value: "1" },
    });
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { answers: Record<string, unknown> };

    expect(body.answers).toEqual({
      "steps.kickoff.inputs.assigneeId": "user_b",
    });
  });

  it("prevents a duplicate submission while one is in flight", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );

    renderCard();
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");

    const button = submitButton();
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(statusResponse({ status: "ACCEPTED" }, 200));
    await screen.findByText(/Resuming the session/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports acceptance and asks for a reread without claiming completion", async () => {
    fetchMock.mockResolvedValue(statusResponse({ status: "ACCEPTED" }, 200));
    const onAnswered = jest.fn();

    renderCard({ onAnswered });
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");
    fireEvent.click(submitButton());

    expect(await screen.findByText(/Resuming the session/)).toBeInTheDocument();
    expect(onAnswered).toHaveBeenCalledTimes(1);
    // No fabricated continuation: the card makes no claim the agent has resumed.
    expect(screen.queryByText(/proposal was generated/i)).toBeNull();
  });
});

describe("failures", () => {
  it("surfaces a server error and does not masquerade as success", async () => {
    fetchMock.mockResolvedValue(
      statusResponse(
        { error: 'An answer for field "steps.kickoff.inputs.title" is required.', code: "INVALID_ANSWER_VALUE" },
        400,
      ),
    );
    const onAnswered = jest.fn();

    renderCard({ onAnswered });
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "is required",
    );
    expect(screen.queryByText(/Resuming the session/)).toBeNull();
    // A validation failure is retryable in place, not a reconcile.
    expect(onAnswered).not.toHaveBeenCalled();
    expect(submitButton()).toBeEnabled();
  });

  it("reconciles a stale interaction instead of replaying the answer", async () => {
    fetchMock.mockResolvedValue(
      statusResponse(
        { error: "The supplied interactionId does not match the pending clarification.", code: "STALE_CLARIFICATION" },
        409,
      ),
    );
    const onAnswered = jest.fn();

    renderCard({ onAnswered });
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match the pending clarification",
    );
    expect(onAnswered).toHaveBeenCalledTimes(1);
    // Reread, not replay: exactly one submission was attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles a transport failure rather than hanging", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderCard();
    type("Which project should the task use?", PROJECT_ID);
    type("What should the task be called?", "Kick off");
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be submitted",
    );
  });
});
