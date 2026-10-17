// src/tests/agent/workflow-criticality.test.ts
//
// Assignment 37.7 — Human criticality decision contract.
//
// Verifies the two pure properties the decision record depends on:
//   1. A decision set is accepted only when it is EXACT and COMPLETE - one
//      boolean per proposal step, no unknown keys, no missing keys.
//   2. Applying an approved set touches `isCritical` and nothing else, and
//      refuses a set that does not belong to the proposal it is applied to.

import {
  applyCriticalityDecisions,
  validateCriticalityDecisions,
} from "@/lib/workflow-types/workflow-criticality";
import {
  WorkflowProposalSchema,
  type WorkflowProposal,
} from "@/lib/workflow-types/workflow-proposal";

const proposal = WorkflowProposalSchema.parse({
  name: "Onboard Client",
  description: "Kick off and notify.",
  steps: {
    setup: {
      action: "task.create",
      inputs: { title: "Setup", projectId: "proj_1" },
      dependsOn: [],
    },
    notify: {
      action: "task.create",
      inputs: { title: "Notify", projectId: "proj_1" },
      dependsOn: ["setup"],
    },
  },
});

describe("37.7 contract — validateCriticalityDecisions", () => {
  it("accepts an exact, complete set of booleans", () => {
    const result = validateCriticalityDecisions(proposal, {
      setup: true,
      notify: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.approved.decisions).toEqual({ setup: true, notify: false });
    }
  });

  it("rejects a set that omits a step as INCOMPLETE_CRITICALITY", () => {
    const result = validateCriticalityDecisions(proposal, { setup: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INCOMPLETE_CRITICALITY",
          path: "notify",
        }),
      ]);
    }
  });

  it("rejects a decision for a step the proposal does not contain", () => {
    const result = validateCriticalityDecisions(proposal, {
      setup: true,
      notify: false,
      ghost: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "UNKNOWN_CRITICALITY_STEP",
          path: "ghost",
        }),
      ]);
    }
  });

  it("rejects a non-boolean decision value", () => {
    const result = validateCriticalityDecisions(proposal, {
      setup: "yes",
      notify: false,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_CRITICALITY_VALUE",
          path: "setup",
        }),
      ]);
    }
  });

  it("rejects a non-object decision set", () => {
    const result = validateCriticalityDecisions(proposal, ["setup"]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0].code).toBe("INVALID_CRITICALITY_VALUE");
    }
  });
});

describe("37.7 contract — applyCriticalityDecisions", () => {
  function approved(decisions: Record<string, boolean>) {
    const result = validateCriticalityDecisions(proposal, decisions);
    if (!result.success) {
      throw new Error("fixture decisions did not validate");
    }
    return result.approved;
  }

  it("overlays isCritical per step and preserves every other field", () => {
    const result = applyCriticalityDecisions(
      proposal,
      approved({
        setup: true,
        notify: false,
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.definition.steps.setup).toEqual({
        id: "setup",
        action: "task.create",
        dependsOn: [],
        config: { title: "Setup", projectId: "proj_1" },
        isCritical: true,
        kind: "ACTION",
      });
      expect(result.definition.steps.notify.isCritical).toBe(false);
      expect(result.definition.steps.notify.dependsOn).toEqual(["setup"]);
    }
  });

  it("does not mutate the input proposal", () => {
    const before = JSON.stringify(proposal);

    applyCriticalityDecisions(proposal, approved({ setup: false, notify: true }));

    expect(JSON.stringify(proposal)).toBe(before);
    expect(proposal.steps.setup.inputs).toEqual({
      title: "Setup",
      projectId: "proj_1",
    });
  });

  it("refuses an approved set that belongs to a different proposal", () => {
    const other = WorkflowProposalSchema.parse({
      name: "Other",
      steps: {
        only: {
          action: "task.create",
          inputs: { title: "Only", projectId: "proj_1" },
          dependsOn: [],
        },
      },
    });

    const approved = validateCriticalityDecisions(other, { only: true });
    expect(approved.success).toBe(true);
    if (!approved.success) return;

    const applied = applyCriticalityDecisions(proposal, approved.approved);

    expect(applied.success).toBe(false);
    if (!applied.success) {
      expect(applied.issues.map((issue) => issue.code)).toContain(
        "UNKNOWN_CRITICALITY_STEP",
      );
      expect(applied.issues.map((issue) => issue.code)).toContain(
        "INCOMPLETE_CRITICALITY",
      );
    }
  });

  it("is deterministic and does not mutate the approved set", () => {
    const approved = validateCriticalityDecisions(proposal, {
      setup: true,
      notify: true,
    });
    if (!approved.success) throw new Error("expected success");

    const before = JSON.stringify(approved.approved.decisions);
    const first = applyCriticalityDecisions(proposal, approved.approved);
    const second = applyCriticalityDecisions(proposal, approved.approved);

    expect(first).toEqual(second);
    expect(JSON.stringify(approved.approved.decisions)).toBe(before);
  });
});

describe("37.7 contract — proposal revision binding", () => {
  function approvedFor(source: WorkflowProposal) {
    const result = validateCriticalityDecisions(source, {
      setup: true,
      notify: false,
    });
    if (!result.success) throw new Error("fixture decisions did not validate");
    return result.approved;
  }

  // Each mutation keeps the exact same step refs (`setup`, `notify`) but changes
  // one meaningful field, so the fingerprint must differ while the ref check
  // still passes. Matching refs are necessary but not sufficient.
  const revisionMutations: Array<[string, (draft: WorkflowProposal) => void]> = [
    ["name", (draft) => { draft.name = "Renamed"; }],
    ["description", (draft) => { draft.description = "Different description."; }],
    ["action", (draft) => { draft.steps.setup.action = "task.update"; }],
    ["inputs", (draft) => { draft.steps.setup.inputs.projectId = "proj_9"; }],
    ["dependencies", (draft) => { draft.steps.notify.dependsOn = []; }],
  ];

  it.each(revisionMutations)(
    "refuses an approval recorded for revision A when only %s differs in revision B",
    (_field, mutate) => {
      const draft = JSON.parse(JSON.stringify(proposal)) as WorkflowProposal;
      mutate(draft);
      const revisionB = WorkflowProposalSchema.parse(draft);

      expect(Object.keys(revisionB.steps)).toEqual(Object.keys(proposal.steps));

      const applied = applyCriticalityDecisions(
        revisionB,
        approvedFor(proposal),
      );

      expect(applied.success).toBe(false);
      if (!applied.success) {
        expect(applied.issues).toEqual([
          expect.objectContaining({ code: "REVISION_MISMATCH" }),
        ]);
      }
    },
  );

  it("applies to the exact approved revision", () => {
    const applied = applyCriticalityDecisions(proposal, approvedFor(proposal));

    expect(applied.success).toBe(true);
    if (applied.success) {
      expect(applied.definition.steps.setup.isCritical).toBe(true);
      expect(applied.definition.steps.notify.isCritical).toBe(false);
    }
  });
});
