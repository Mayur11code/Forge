/**
 * FC-019 — Trigger Filtering, Variable Propagation & Storm Protection Test Suite
 *
 * Verifies:
 * 1. Deterministic trigger filter evaluation (equals, not_equals, in, contains).
 * 2. Compound AND / OR logical evaluation.
 * 3. Fail-closed security on missing or malformed paths.
 * 4. Variable propagation from trigger event payload into workflow execution context ({{trigger.outputs.field}}).
 * 5. Storm suppression: workflow-originated task events terminate at depth 1 with zero recursive ignition.
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

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_storm_test" }),
  receiveMessages: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn().mockResolvedValue("ADVANCED"),
}));

import {
  evaluateTriggerFilter,
  type TriggerFilterConfig,
} from "@/lib/workflow-types/trigger-filter";
import {
  dispatchDomainEvent,
} from "@/lib/workflow/execution/event-dispatcher";
import type { DomainEventOutboxRecord } from "@/lib/events/domain-outbox";
import { createTaskAction } from "@/lib/workflow/actions/core/create-task";
import {
  store,
  resetStore,
  restoreWorkflowDouble,
  prismaDouble,
} from "./helpers/prisma-double";

const ORG_A = "org_alpha";
const PROJECT_A = "clx1234567890abcdefghijkl";

describe("FC-019: Trigger Filtering, Variable Propagation & Storm Protection", () => {
  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    jest.clearAllMocks();

    store.projects.push({
      id: PROJECT_A,
      orgId: ORG_A,
      name: "Alpha Project",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  describe("Deterministic Filter Evaluator", () => {
    it("evaluates equals operator accurately", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "priority", operator: "equals", value: "URGENT" }],
      };

      expect(evaluateTriggerFilter(config, { priority: "URGENT" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "LOW" })).toBe(false);
      expect(evaluateTriggerFilter(config, {})).toBe(false);
    });

    it("evaluates not_equals operator accurately", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "status", operator: "not_equals", value: "DONE" }],
      };

      expect(evaluateTriggerFilter(config, { status: "IN_PROGRESS" })).toBe(true);
      expect(evaluateTriggerFilter(config, { status: "DONE" })).toBe(false);
    });

    it("evaluates in operator accurately", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "status", operator: "in", value: "TODO, IN_PROGRESS" }],
      };

      expect(evaluateTriggerFilter(config, { status: "TODO" })).toBe(true);
      expect(evaluateTriggerFilter(config, { status: "IN_PROGRESS" })).toBe(true);
      expect(evaluateTriggerFilter(config, { status: "DONE" })).toBe(false);
    });

    it("evaluates contains operator accurately", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "title", operator: "contains", value: "Security" }],
      };

      expect(evaluateTriggerFilter(config, { title: "Urgent Security Patch" })).toBe(true);
      expect(evaluateTriggerFilter(config, { title: "Update UI Styling" })).toBe(false);
    });

    it("evaluates compound AND / OR logic correctly", () => {
      const andConfig: TriggerFilterConfig = {
        logic: "AND",
        rules: [
          { field: "priority", operator: "equals", value: "URGENT" },
          { field: "status", operator: "equals", value: "TODO" },
        ],
      };

      expect(evaluateTriggerFilter(andConfig, { priority: "URGENT", status: "TODO" })).toBe(true);
      expect(evaluateTriggerFilter(andConfig, { priority: "URGENT", status: "DONE" })).toBe(false);

      const orConfig: TriggerFilterConfig = {
        logic: "OR",
        rules: [
          { field: "priority", operator: "equals", value: "URGENT" },
          { field: "priority", operator: "equals", value: "HIGH" },
        ],
      };

      expect(evaluateTriggerFilter(orConfig, { priority: "HIGH" })).toBe(true);
      expect(evaluateTriggerFilter(orConfig, { priority: "URGENT" })).toBe(true);
      expect(evaluateTriggerFilter(orConfig, { priority: "LOW" })).toBe(false);
    });

    it("fails closed on missing, malformed, or nested undefined paths", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "metadata.nested.key", operator: "equals", value: "expected" }],
      };

      expect(evaluateTriggerFilter(config, null as unknown as Record<string, unknown>)).toBe(false);
      expect(evaluateTriggerFilter(config, {})).toBe(false);
      expect(evaluateTriggerFilter(config, { metadata: null })).toBe(false);
      expect(evaluateTriggerFilter(config, { metadata: { nested: {} } })).toBe(false);
    });
  });

  describe("Workflow Dispatch Filtering Integration", () => {
    it("filters out domain event if filter criteria are not met and marks ledger as FILTERED", async () => {
      const filterConfig: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "priority", operator: "equals", value: "URGENT" }],
      };

      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_filtered",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Filtered V1",
          eventId: "task.created",
          definition: {
            id: "wf_filtered_def",
            name: "Filtered Workflow Definition",
            steps: {
              trig_1: {
                id: "trig_1",
                kind: "TRIGGER" as const,
                action: "task.created",
                dependsOn: [],
                config: { filter: filterConfig },
              },
            },
          },
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_filtered",
          orgId: ORG_A,
          name: "Filtered Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      // Event with non-matching priority: LOW
      const event: DomainEventOutboxRecord = {
        id: "deo_filtered_1",
        eventId: "evt_filter_test",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_low",
        payload: { priority: "LOW", title: "Low priority task" },
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
      expect(result.outcomes[0].status).toBe("FILTERED");
      expect(result.outcomes[0].runId).toBeUndefined();

      // Assert NO run was started
      expect(store.runs).toHaveLength(0);

      // Assert ledger recorded status = FILTERED
      const dispatch = store.workflowTriggerDispatch.find(
        (d) => d.eventId === "evt_filter_test" && d.workflowId === "wf_filtered",
      );
      expect(dispatch).toBeDefined();
      expect(dispatch?.status).toBe("FILTERED");
    });
  });

  describe("Variable Propagation & Storm Invariant", () => {
    it("propagates trigger payload into initial execution context under trigger.outputs", async () => {
      const version = await prismaDouble.workflowVersion.create({
        data: {
          workflowId: "wf_var_prop",
          versionNumber: 1,
          orgId: ORG_A,
          name: "Var Prop V1",
          eventId: "task.created",
          definition: {
            id: "wf_var_prop_def",
            name: "Var Prop Definition",
            steps: {
              trig_1: {
                id: "trig_1",
                kind: "TRIGGER" as const,
                action: "task.created",
                dependsOn: [],
                config: {},
              },
            },
          },
        },
      });

      await prismaDouble.workflow.create({
        data: {
          id: "wf_var_prop",
          orgId: ORG_A,
          name: "Var Prop Workflow",
          isActive: true,
          publishedVersionId: version.id,
        },
      });

      const eventPayload = {
        taskId: "task_prop_101",
        title: "Propagated Task Title",
        priority: "HIGH",
      };

      const event: DomainEventOutboxRecord = {
        id: "deo_prop_1",
        eventId: "evt_prop_101",
        orgId: ORG_A,
        eventType: "task.created",
        entityType: "TASK",
        entityId: "task_prop_101",
        payload: eventPayload,
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
      expect(result.outcomes[0].status).toBe("STARTED");
      const runId = result.outcomes[0].runId;

      const run = store.runs.find((r) => r.id === runId);
      expect(run).toBeDefined();

      const context = run?.context as { trigger?: { outputs?: Record<string, unknown> } };
      expect(context.trigger?.outputs).toEqual(eventPayload);
      expect(context.trigger?.outputs?.title).toBe("Propagated Task Title");
      expect(context.trigger?.outputs?.priority).toBe("HIGH");
    });

    it("STORM PROTECTION: workflow-originated task creation terminates at depth 1 with zero recursive ignition", async () => {
      // 1. Workflow executes a task.create action
      store.workflows.push({
        id: "wf_parent",
        orgId: ORG_A,
        name: "Parent Workflow",
        isActive: true,
      });

      const actionContext = {
        workflowId: "wf_parent",
        runId: "run_parent_1",
        stepId: "step_make_child_task",
        inputs: {
          projectId: PROJECT_A,
          title: "Child Task Created By Workflow",
          priority: "HIGH",
        },
      };

      const actionResult = await createTaskAction.execute(actionContext);

      expect(actionResult.success).toBe(true);
      if (!actionResult.success) return;
      const data = actionResult.data as { taskId?: string } | undefined;
      const childTaskId = String(data?.taskId);

      // 2. Fetch the domain event generated for this child task
      const childOutboxEvent = store.domainEventOutbox.find(
        (e) => e.entityId === childTaskId && e.eventType === "task.created",
      );

      expect(childOutboxEvent).toBeDefined();
      expect(childOutboxEvent?.originType).toBe("WORKFLOW");
      expect(childOutboxEvent?.workflowEligible).toBe(false);
      expect(childOutboxEvent?.suppressionReason).toBe("WORKFLOW_ORIGINATED");

      // 3. Dispatch the event: Global dispatcher MUST NOT ignite any workflows!
      const dispatchResult = await dispatchDomainEvent(childOutboxEvent as unknown as DomainEventOutboxRecord);

      expect(dispatchResult.workflowEligible).toBe(false);
      expect(dispatchResult.matchedWorkflows).toBe(0);
      expect(dispatchResult.outcomes).toHaveLength(0);

      // Verify no recursive workflow runs were ever created
      expect(store.runs).toHaveLength(0);
    });
  });
});
