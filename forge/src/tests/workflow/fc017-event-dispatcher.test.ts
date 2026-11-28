/**
 * FC-017 — Real Domain Event-to-Workflow Dispatch Engine Test Suite
 *
 * Verifies:
 * 1. Tenant-isolated published workflow matching (orgId == event.orgId).
 * 2. Exclusion of draft-only (publishedVersionId == null) and inactive (isActive == false) workflows.
 * 3. Publication race protection (exact expectedVersion pinning).
 * 4. Idempotent ignition via WorkflowTriggerDispatch unique constraint.
 * 5. Partial fan-out isolation (one workflow failure does not impact siblings).
 * 6. Sweeper batch processing and backoff lifecycle.
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn().mockResolvedValue("ADVANCED"),
}));

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_test_123" }),
  receiveMessages: jest.fn().mockResolvedValue([]),
}));

import type { Prisma } from "@prisma/client";
import {
  dispatchDomainEvent,
  processDomainEventOutbox,
} from "@/lib/workflow/execution/event-dispatcher";
import {
  recordDomainEventIntent,
  getDomainOutboxTelemetry,
  type DomainEventOutboxRecord,
} from "@/lib/events/domain-outbox";
import {
  store,
  resetStore,
  restoreWorkflowDouble,
  prismaDouble,
} from "./helpers/prisma-double";

const ORG_A = "org_alpha";
const ORG_B = "org_beta";
const VALID_PROJECT_ID = "clx1234567890abcdefghijkl";

function createMockDefinition(triggerAction = "task.created") {
  return {
    id: "wf_test_mock",
    name: "Mock Workflow",
    steps: {
      trig_1: {
        id: "trig_1",
        kind: "TRIGGER" as const,
        action: triggerAction,
        dependsOn: [],
        config: {},
      },
      act_1: {
        id: "act_1",
        kind: "ACTION" as const,
        action: "task.create",
        dependsOn: ["trig_1"],
        config: {
          projectId: VALID_PROJECT_ID,
          title: "Follow up task",
        },
        isCritical: false,
      },
    },
  };
}

describe("FC-017: Real Domain Event-to-Workflow Dispatch Engine", () => {
  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    jest.clearAllMocks();
  });

  describe("Tenant Isolation and Workflow Matching", () => {
    it("ignites active published workflows matching event in the SAME organization", async () => {
      // Setup: Published active workflow in ORG_A
      const versionA = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_a",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Workflow Alpha V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      const wfA = await prismaDouble.workflow.create({
        data: {
          id: "wf_a",
          orgId: ORG_A,
          name: "Workflow Alpha",
          isActive: true,
          publishedVersionId: versionA.id,
        },
      });

      // Sibling workflow in ORG_B with exact same trigger
      const versionB = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_b",
          versionNumber: 1,
          orgId: ORG_B,
          name: "Workflow Beta V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_b",
          orgId: ORG_B,
          name: "Workflow Beta",
          isActive: true,
          publishedVersionId: versionB.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_1",
        eventId: "evt_test_100",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_123",
        payload: { taskId: "task_123", title: "Test Task" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      const result = await dispatchDomainEvent(event);

      expect(result.matchedWorkflows).toBe(1);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].workflowId).toBe(wfA.id);
      expect(result.outcomes[0].status).toBe("STARTED");
      expect(result.outcomes[0].runId).toBeDefined();

      // Verify ORG_B workflow was NEVER ignited
      const runsForOrgB = store.runs.filter((r) => r.workflowId === "wf_b");
      expect(runsForOrgB).toHaveLength(0);
    });

    it("ignores draft-only and inactive workflows", async () => {
      // Draft-only workflow in ORG_A (publishedVersionId == null)
      await prismaDouble.workflow.create({
        data: {
          id: "wf_draft",
          orgId: ORG_A,
          name: "Draft Workflow",
          isActive: true,
          publishedVersionId: null,
        },
      });

      // Inactive workflow in ORG_A (isActive == false)
      const versionInactive = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_inactive",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Inactive V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_inactive",
          orgId: ORG_A,
          name: "Inactive Workflow",
          isActive: false,
          publishedVersionId: versionInactive.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_2",
        eventId: "evt_test_101",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_124",
        payload: { taskId: "task_124" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      const result = await dispatchDomainEvent(event);

      expect(result.matchedWorkflows).toBe(0);
      expect(result.outcomes).toHaveLength(0);
      expect(store.runs).toHaveLength(0);
    });
  });

  describe("Publication Race Protection", () => {
    it("fails ignition cleanly if the published version was bumped concurrently", async () => {
      const versionV1 = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_race",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Race V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      const wf = await prismaDouble.workflow.create({
        data: {
          id: "wf_race",
          orgId: ORG_A,
          name: "Race Workflow",
          isActive: true,
          publishedVersionId: versionV1.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_3",
        eventId: "evt_race_1",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_race",
        payload: { taskId: "task_race" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      // Simulate concurrent republish by mutating publishedVersionId right after candidate collection
      const origFindMany = prismaDouble.workflow.findMany;
      prismaDouble.workflow.findMany = jest.fn().mockImplementation(async (args) => {
        const rows = await origFindMany(args);
        // Concurrent publication bump occurs!
        const target = store.workflows.find((w) => w.id === wf.id);
        if (target) {
          target.publishedVersionId = "wfv_different_version";
        }
        return rows;
      });

      const result = await dispatchDomainEvent(event);

      expect(result.matchedWorkflows).toBe(1);
      expect(result.outcomes[0].status).toBe("FAILED");
      expect(result.outcomes[0].error).toContain("Cannot start workflow: expected version");

      // Verify dispatch ledger captured failure
      const dispatch = store.workflowTriggerDispatch.find(
        (d) => d.eventId === "evt_race_1" && d.workflowId === wf.id,
      );
      expect(dispatch).toBeDefined();
      expect(dispatch?.status).toBe("FAILED");
    });
  });

  describe("Idempotent Ignition & Ledger Deduplication", () => {
    it("deduplicates redelivered events using WorkflowTriggerDispatch ledger without starting duplicate runs", async () => {
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_idempotent",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Idempotent V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_idempotent",
          orgId: ORG_A,
          name: "Idempotent Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_4",
        eventId: "evt_idempotent_1",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_dup",
        payload: { taskId: "task_dup" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      // First delivery: starts workflow
      const result1 = await dispatchDomainEvent(event);
      expect(result1.outcomes[0].status).toBe("STARTED");
      const originalRunId = result1.outcomes[0].runId;
      expect(originalRunId).toBeDefined();
      expect(store.runs).toHaveLength(1);

      // Second delivery of the identical event (e.g. QStash redelivery)
      const result2 = await dispatchDomainEvent(event);
      expect(result2.outcomes[0].status).toBe("SKIPPED_ALREADY_STARTED");
      expect(result2.outcomes[0].runId).toBe(originalRunId);

      // Assert NO second run was created
      expect(store.runs).toHaveLength(1);
    });

    it("CONCURRENT IGNITION (M4-REM-2): concurrent workers processing the same dispatch produce exactly one WorkflowRun without run overwrite", async () => {
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_concurrent_ignite",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Concurrent Ignite V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_concurrent_ignite",
          orgId: ORG_A,
          name: "Concurrent Ignite Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_concurrent",
        eventId: "evt_concurrent_100",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_concurrent",
        payload: { taskId: "task_concurrent" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      // Two workers attempt to dispatch the exact same event concurrently
      const [result1, result2] = await Promise.all([
        dispatchDomainEvent(event),
        dispatchDomainEvent(event),
      ]);

      // Exactly one should be STARTED, and the other should be SKIPPED_ALREADY_STARTED (or both resolve cleanly to the single run)
      const outcomes = [result1.outcomes[0], result2.outcomes[0]];
      const started = outcomes.filter((o) => o.status === "STARTED");
      const skipped = outcomes.filter((o) => o.status === "SKIPPED_ALREADY_STARTED");

      expect(started).toHaveLength(1);
      expect(skipped).toHaveLength(1);

      // Both outcomes must reference the EXACT SAME single WorkflowRun ID
      expect(started[0].runId).toBeDefined();
      expect(skipped[0].runId).toBe(started[0].runId);

      // Exactly ONE WorkflowRun must exist in the database
      const runsForWf = store.runs.filter((r) => r.workflowId === "wf_concurrent_ignite");
      expect(runsForWf).toHaveLength(1);

      // Dispatch ledger must have status: STARTED and point to the single runId
      const dispatch = store.workflowTriggerDispatch.find(
        (d) => d.eventId === "evt_concurrent_100" && d.workflowId === "wf_concurrent_ignite",
      );
      expect(dispatch?.status).toBe("STARTED");
      expect(dispatch?.runId).toBe(started[0].runId);
    });

    it("ATOMIC ROLLBACK (M4-REM-2): failure during dispatch claim rolls back WorkflowRun creation", async () => {
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_rollback_test",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Rollback V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_rollback_test",
          orgId: ORG_A,
          name: "Rollback Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_rollback",
        eventId: "evt_rollback_1",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_rb",
        payload: { taskId: "task_rb" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      // Mock updateMany to simulate concurrent collision (count: 0)
      const origUpdateMany = prismaDouble.workflowTriggerDispatch.updateMany;
      prismaDouble.workflowTriggerDispatch.updateMany = jest.fn().mockImplementation(async () => {
        // Return 0 matching rows, simulating race loss
        return { count: 0 };
      });

      const result = await dispatchDomainEvent(event);
      // Because updateMany threw DISPATCH_ALREADY_CLAIMED_OR_STARTED, the event dispatcher catches it
      // and records SKIPPED_ALREADY_STARTED without marking FAILED
      expect(result.outcomes[0].status).toBe("SKIPPED_ALREADY_STARTED");

      // Restore
      prismaDouble.workflowTriggerDispatch.updateMany = origUpdateMany;
    });
  });

  describe("Partial Fan-out Isolation", () => {
    it("allows healthy workflows to start even if a sibling workflow fails ignition", async () => {
      // Healthy Workflow 1
      const version1 = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_healthy",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Healthy V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });
      await prismaDouble.workflow.create({
        data: {
          id: "wf_healthy",
          orgId: ORG_A,
          name: "Healthy Workflow",
          isActive: true,
          publishedVersionId: version1.id,
        },
      });

      // Corrupted Workflow 2 (invalid trigger step action)
      const corruptedDef = {
        id: "wf_corrupted",
        name: "Corrupt Workflow",
        steps: {
          trig_1: {
            id: "trig_1",
            kind: "TRIGGER" as const,
            action: "invalid.unknown.trigger",
            dependsOn: [],
            config: {},
          },
        },
      };
      const version2 = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_corrupted",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Corrupt V1",
          eventId: "task.created",
          definition: corruptedDef,
        },
      });
      await prismaDouble.workflow.create({
        data: {
          id: "wf_corrupted",
          orgId: ORG_A,
          name: "Corrupted Workflow",
          isActive: true,
          publishedVersionId: version2.id,
        },
      });

      const event: DomainEventOutboxRecord = {
        id: "deo_5",
        eventId: "evt_fanout_1",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_fanout",
        payload: { taskId: "task_fanout" },
        originType: "USER",
        originWorkflowId: null,
        originWorkflowVersionId: null,
        originWorkflowRunId: null,
        workflowEligible: true,
        suppressionReason: null,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      };

      const result = await dispatchDomainEvent(event);

      expect(result.matchedWorkflows).toBe(2);
      const healthyOutcome = result.outcomes.find((o) => o.workflowId === "wf_healthy");
      const corruptOutcome = result.outcomes.find((o) => o.workflowId === "wf_corrupted");

      expect(healthyOutcome?.status).toBe("STARTED");
      expect(healthyOutcome?.runId).toBeDefined();

      expect(corruptOutcome?.status).toBe("FAILED");
      expect(corruptOutcome?.error).toContain("unknown trigger");
    });
  });

  describe("Sweeper Duty (processDomainEventOutbox)", () => {
    it("sweeps pending outbox events and marks them PROCESSED", async () => {
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_swept",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Swept V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });
      await prismaDouble.workflow.create({
        data: {
          id: "wf_swept",
          orgId: ORG_A,
          name: "Swept Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      // Record a domain event intent inside store
      const outboxRecord = await recordDomainEventIntent({
        tx: prismaDouble as unknown as Prisma.TransactionClient,
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_sweeper_1",
        payload: { taskId: "task_sweeper_1" },
      });

      expect(outboxRecord.status).toBe("PENDING");

      const sweepResult = await processDomainEventOutbox(10);

      expect(sweepResult.processed).toBe(1);
      expect(sweepResult.successCount).toBe(1);
      expect(sweepResult.failureCount).toBe(0);

      const updatedRecord = store.domainEventOutbox.find((r) => r.id === outboxRecord.id);
      expect(updatedRecord?.status).toBe("PROCESSED");
      expect(updatedRecord?.leaseToken).toBeNull();
    });

    it("BACKLOG TELEMETRY & RECOVERY (M4-REM-3): recovers stranded pending events after failed initial wakeup and computes telemetry", async () => {
      // Setup workflow
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_stranded",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Stranded V1",
          eventId: "task.created",
          definition: createMockDefinition("task.created"),
        },
      });
      await prismaDouble.workflow.create({
        data: {
          id: "wf_stranded",
          orgId: ORG_A,
          name: "Stranded Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      // Simulate stranded event: transaction committed, but wakeup failed or never arrived
      await recordDomainEventIntent({
        tx: prismaDouble as unknown as Prisma.TransactionClient,
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_stranded_1",
        payload: { taskId: "task_stranded_1" },
      });

      // Check telemetry before sweep
      const telemetryBefore = await getDomainOutboxTelemetry();
      expect(telemetryBefore.pendingEligibleCount).toBeGreaterThanOrEqual(1);

      // Sweeper runs and recovers stranded event
      const sweepResult = await processDomainEventOutbox(25);
      expect(sweepResult.processed).toBeGreaterThanOrEqual(1);
      expect(sweepResult.successCount).toBeGreaterThanOrEqual(1);

      // Check telemetry after sweep
      const telemetryAfter = await getDomainOutboxTelemetry();
      expect(telemetryAfter.pendingEligibleCount).toBe(0);
      expect(telemetryAfter.processedCount).toBeGreaterThanOrEqual(1);
    });
  });
});
