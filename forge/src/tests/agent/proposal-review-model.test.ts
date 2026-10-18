// src/tests/agent/proposal-review-model.test.ts
//
// Assignment 37.9 — the pure review projection used by BOTH the session read
// route and the client card, so the two can never render different views of the
// same persisted proposal.
//
// Pure and node-only: no prisma, no DOM. The component behaviour is covered by
// proposal-review-card.test.tsx.

import {
  buildProposalReviewModel,
  orderProposalSteps,
} from "@/lib/ai/agent/services/proposal-review";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

const PROJECT_ID = "clxyz0000000000000000000a";

function step(
  action: string,
  inputs: Record<string, unknown>,
  dependsOn: string[] = [],
) {
  return { action, inputs, dependsOn };
}

const PROPOSAL: WorkflowProposal = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    // Insertion order deliberately NOT the dependency order.
    follow: step("task.create", { title: "Follow up", projectId: PROJECT_ID }, [
      "kickoff",
    ]),
    kickoff: step("task.create", { title: "Kick off", projectId: PROJECT_ID }),
  },
};

describe("orderProposalSteps", () => {
  it("places every ref after the refs it depends on", () => {
    expect(orderProposalSteps(PROPOSAL)).toEqual(["kickoff", "follow"]);
  });

  it("is deterministic regardless of insertion order", () => {
    const reversed: WorkflowProposal = {
      name: "x",
      steps: {
        follow: PROPOSAL.steps.follow,
        kickoff: PROPOSAL.steps.kickoff,
      },
    };

    expect(orderProposalSteps(reversed)).toEqual(orderProposalSteps(PROPOSAL));
  });

  it("ignores a dependency that names a ref outside the proposal", () => {
    const proposal: WorkflowProposal = {
      name: "x",
      steps: {
        only: step("task.create", { title: "t", projectId: PROJECT_ID }, [
          "ghost",
        ]),
      },
    };

    expect(orderProposalSteps(proposal)).toEqual(["only"]);
  });

  it("still returns every step when the graph has a cycle", () => {
    // The 37.4 graph gate forbids cycles before approval, so this is a defensive
    // totality property: a projection must never silently drop a step.
    const proposal: WorkflowProposal = {
      name: "x",
      steps: {
        a: step("task.create", { title: "a", projectId: PROJECT_ID }, ["b"]),
        b: step("task.create", { title: "b", projectId: PROJECT_ID }, ["a"]),
      },
    };

    expect([...orderProposalSteps(proposal)].sort()).toEqual(["a", "b"]);
  });
});

describe("buildProposalReviewModel", () => {
  it("reads the name from the proposal, never a compiler placeholder", () => {
    const model = buildProposalReviewModel({ proposal: PROPOSAL });

    expect(model.name).toBe("Onboard a client");
    expect(model.description).toBe("Kick off the onboarding.");
  });

  it("reports a null description when the proposal has none", () => {
    const model = buildProposalReviewModel({
      proposal: { name: "x", steps: PROPOSAL.steps },
    });

    expect(model.description).toBeNull();
  });

  it("lists steps sorted by ref with their action, deps and inputs", () => {
    const model = buildProposalReviewModel({ proposal: PROPOSAL });

    expect(model.stepCount).toBe(2);
    expect(model.steps.map((s) => s.ref)).toEqual(["follow", "kickoff"]);
    const follow = model.steps.find((s) => s.ref === "follow")!;
    expect(follow.action).toBe("task.create");
    expect(follow.dependsOn).toEqual(["kickoff"]);
    expect(follow.inputs).toEqual({ title: "Follow up", projectId: PROJECT_ID });
  });

  it("exposes a deterministic dependency order", () => {
    const model = buildProposalReviewModel({ proposal: PROPOSAL });

    expect(model.order).toEqual(["kickoff", "follow"]);
  });

  it("reads a well-formed criticality map and rejects a malformed one", () => {
    const good = buildProposalReviewModel({
      proposal: PROPOSAL,
      criticality: { kickoff: true, follow: false },
    });
    expect(good.criticality).toEqual({ kickoff: true, follow: false });

    const bad = buildProposalReviewModel({
      proposal: PROPOSAL,
      criticality: { kickoff: "yes" },
    });
    expect(bad.criticality).toBeNull();
  });

  it("reads the recorded clarification answers", () => {
    const model = buildProposalReviewModel({
      proposal: PROPOSAL,
      clarification: { project: "proj_1" },
    });

    expect(model.clarification).toEqual({ project: "proj_1" });
  });

  it("renders the review deadline as an ISO timestamp", () => {
    const deadline = new Date("2026-09-29T00:15:00.000Z");
    const model = buildProposalReviewModel({
      proposal: PROPOSAL,
      reviewExpiresAt: deadline,
    });

    expect(model.reviewExpiresAt).toBe("2026-09-29T00:15:00.000Z");
  });

  it("reports a null deadline when none is set", () => {
    const model = buildProposalReviewModel({
      proposal: PROPOSAL,
      reviewExpiresAt: null,
    });

    expect(model.reviewExpiresAt).toBeNull();
  });
});
