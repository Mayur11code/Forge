/** @jest-environment jsdom */

// src/tests/workflow/run-workflow-button.test.tsx
//
// Assignment 37.12 — the explicit execution control.
//
// The Run button is the human action that hands a materialized workflow to the
// engine. This suite pins the UI contract:
//
//   1. it calls the server action with the workflow id and the org SLUG, and
//      passes NO fabricated trigger payload;
//   2. a click while a request is in flight does not fire a second request
//      (single-submission guard) and the control is disabled while pending;
//   3. a failed start surfaces the error and leaves the control retryable;
//   4. the component reports START only — on success it navigates to the
//      authoritative run view and never asserts completion.

import "@testing-library/jest-dom";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/app/actions/workflows/workflow-run", () => ({
  triggerWorkflowRun: jest.fn(),
}));

import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";
import RunWorkflowButton from "@/features/organizations/components/workflow/RunWorkflowButton";

const triggerWorkflowRunMock = triggerWorkflowRun as jest.Mock;

const WORKFLOW_ID = "wf_materialized";
const SLUG = "acme";

beforeEach(() => {
  jest.clearAllMocks();
});

it("calls the action with the workflow id and slug, and no fabricated payload", async () => {
  triggerWorkflowRunMock.mockResolvedValue({
    success: true,
    runId: "run_1",
    redirectTo: `/org/${SLUG}/runs/run_1`,
  });

  render(<RunWorkflowButton workflowId={WORKFLOW_ID} orgId={SLUG} />);
  fireEvent.click(screen.getByRole("button", { name: /test workflow/i }));

  await waitFor(() => expect(triggerWorkflowRunMock).toHaveBeenCalledTimes(1));
  // Exactly two arguments: no third "payload" argument, so nothing fabricated
  // (e.g. a hardcoded projectId) can reach the boundary.
  expect(triggerWorkflowRunMock).toHaveBeenCalledWith(WORKFLOW_ID, SLUG);
  expect(triggerWorkflowRunMock.mock.calls[0]).toHaveLength(2);
});

it("navigates to the run view on success and does not claim completion", async () => {
  triggerWorkflowRunMock.mockResolvedValue({
    success: true,
    runId: "run_1",
    redirectTo: `/org/${SLUG}/runs/run_1`,
  });

  render(<RunWorkflowButton workflowId={WORKFLOW_ID} orgId={SLUG} />);
  fireEvent.click(screen.getByRole("button", { name: /test workflow/i }));

  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(`/org/${SLUG}/runs/run_1`),
  );
  // The only status word is "starting", never "completed"/"finished".
  expect(screen.queryByText(/complete|finished|done/i)).not.toBeInTheDocument();
});

it("refuses a second request while the first is in flight (single submission)", async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  triggerWorkflowRunMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );

  render(<RunWorkflowButton workflowId={WORKFLOW_ID} orgId={SLUG} />);
  const button = screen.getByRole("button", { name: /test workflow/i });

  fireEvent.click(button);
  await waitFor(() => expect(triggerWorkflowRunMock).toHaveBeenCalledTimes(1));

  // The control is disabled while pending, and a second click adds no request.
  expect(button).toBeDisabled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(triggerWorkflowRunMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveFirst({
      success: true,
      runId: "run_1",
      redirectTo: `/org/${SLUG}/runs/run_1`,
    });
  });
});

it("surfaces a failed start and leaves the control retryable", async () => {
  const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
  triggerWorkflowRunMock.mockResolvedValueOnce({
    success: false,
    error: "Invalid trigger data.",
  });

  render(<RunWorkflowButton workflowId={WORKFLOW_ID} orgId={SLUG} />);
  fireEvent.click(screen.getByRole("button", { name: /test workflow/i }));

  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith("Invalid trigger data."),
  );

  // The guard is released: the control is enabled again and a retry issues a
  // fresh request.
  const button = screen.getByRole("button", { name: /test workflow/i });
  expect(button).not.toBeDisabled();
  triggerWorkflowRunMock.mockResolvedValueOnce({
    success: true,
    runId: "run_2",
    redirectTo: `/org/${SLUG}/runs/run_2`,
  });
  fireEvent.click(button);
  await waitFor(() => expect(triggerWorkflowRunMock).toHaveBeenCalledTimes(2));

  alertSpy.mockRestore();
});

it("stays retryable if the action throws (transport failure)", async () => {
  const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
  triggerWorkflowRunMock.mockRejectedValueOnce(new Error("network down"));

  render(<RunWorkflowButton workflowId={WORKFLOW_ID} orgId={SLUG} />);
  fireEvent.click(screen.getByRole("button", { name: /test workflow/i }));

  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Failed to start workflow."));
  expect(screen.getByRole("button", { name: /test workflow/i })).not.toBeDisabled();

  alertSpy.mockRestore();
});
