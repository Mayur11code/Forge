// src/lib/workflow/execution/event-dispatcher.ts
//
// FC-017: Real Domain Event-to-Workflow Dispatch Engine.
//
// Guarantees:
// 1. Tenant-isolated published workflow matching (orgId == event.orgId).
// 2. Exact WorkflowVersion pinning (matches immutable published version, fails if republished).
// 3. Trigger filter evaluation (fail-closed, deterministic, zero eval).
// 4. Idempotent ignition via WorkflowTriggerDispatch ledger (unique constraint on eventId + workflowId).
// 5. Partial fan-out isolation (one workflow failure does not duplicate or block siblings).
// 6. Workflow-originated event suppression (tasks created by workflows are marked ineligible).

import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import {
  claimDomainOutboxBatch,
  completeDomainOutboxEvent,
  failDomainOutboxEvent,
  type DomainEventOutboxRecord,
} from "@/lib/events/domain-outbox";
import { mapDomainEventToTrigger } from "@/lib/events/domain-event-mapping";
import {
  evaluateTriggerFilter,
  type TriggerFilterConfig,
} from "@/lib/workflow-types/trigger-filter";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { WorkflowDefinition } from "@/lib/workflow-types/workflow";

export interface WorkflowDispatchOutcome {
  workflowId: string;
  workflowVersionId: string;
  dispatchId: string;
  status: "STARTED" | "FILTERED" | "SKIPPED_ALREADY_STARTED" | "FAILED";
  runId?: string;
  error?: string;
}

export interface DomainEventDispatchResult {
  eventId: string;
  eventType: string;
  orgId: string;
  workflowEligible: boolean;
  matchedWorkflows: number;
  outcomes: WorkflowDispatchOutcome[];
}

/**
 * Dispatches a single domain event to all eligible active published workflows in its organization.
 */
export async function dispatchDomainEvent(
  event: DomainEventOutboxRecord,
): Promise<DomainEventDispatchResult> {
  const canonicalTrigger = mapDomainEventToTrigger(event.eventType) || event.eventType;

  // Invariant: Workflow-originated mutations are not eligible for global workflow dispatch
  if (!event.workflowEligible) {
    return {
      eventId: event.eventId,
      eventType: canonicalTrigger,
      orgId: event.orgId,
      workflowEligible: false,
      matchedWorkflows: 0,
      outcomes: [],
    };
  }

  // 1. Strict Tenant Boundary: Query active published workflows in exactly the same org
  const candidateWorkflows = await db.workflow.findMany({
    where: {
      orgId: event.orgId,
      isActive: true,
      publishedVersionId: { not: null },
    },
    include: {
      publishedVersion: true,
    },
  });

  const matchingWorkflows = candidateWorkflows.filter((wf) => {
    if (!wf.publishedVersion) return false;
    // Check top-level eventId or step-level trigger action
    if (wf.publishedVersion.eventId === canonicalTrigger) return true;

    try {
      const def = wf.publishedVersion.definition as unknown as WorkflowDefinition;
      if (def && typeof def === "object" && def.steps) {
        return Object.values(def.steps).some(
          (step) => step.kind === "TRIGGER" && step.action === canonicalTrigger,
        );
      }
    } catch {
      return false;
    }
    return false;
  });

  const outcomes: WorkflowDispatchOutcome[] = [];

  for (const workflow of matchingWorkflows) {
    const version = workflow.publishedVersion!;
    let filterConfig: TriggerFilterConfig | null = null;

    try {
      const def = version.definition as unknown as WorkflowDefinition;
      if (def && typeof def === "object" && def.steps) {
        const triggerStep = Object.values(def.steps).find((s) => s.kind === "TRIGGER");
        if (triggerStep?.config?.filter) {
          filterConfig = triggerStep.config.filter as unknown as TriggerFilterConfig;
        }
      }
    } catch {
      filterConfig = null;
    }

    // 2. Evaluate Trigger Filter (FC-019)
    const payloadRecord = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    const passesFilter = evaluateTriggerFilter(filterConfig, payloadRecord);

    // 3. Durable Dispatch Ledger & Idempotency Key: @@unique([eventId, workflowId])
    type DispatchRow = {
      id: string;
      eventId: string;
      orgId: string;
      workflowId: string;
      workflowVersionId: string;
      runId: string | null;
      status: string;
    };

    let dispatch: DispatchRow;
    try {
      dispatch = await (db as unknown as {
        workflowTriggerDispatch: {
          upsert: (args: unknown) => Promise<DispatchRow>;
        };
      }).workflowTriggerDispatch.upsert({
        where: {
          eventId_workflowId: {
            eventId: event.eventId,
            workflowId: workflow.id,
          },
        },
        create: {
          eventId: event.eventId,
          orgId: event.orgId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          status: passesFilter ? "PENDING" : "FILTERED",
        },
        update: {},
      });
    } catch (upsertErr) {
      // In concurrent delivery, another worker may have inserted the row concurrently.
      // Recover existing dispatch rather than failing (M4-REM-2).
      const isUniqueCollision =
        (upsertErr as { code?: string })?.code === "P2002" ||
        (upsertErr instanceof Error && upsertErr.message.includes("Unique constraint failed"));

      if (isUniqueCollision) {
        const existing = await (db as unknown as {
          workflowTriggerDispatch: {
            findUnique: (args: unknown) => Promise<DispatchRow | null>;
          };
        }).workflowTriggerDispatch.findUnique({
          where: {
            eventId_workflowId: {
              eventId: event.eventId,
              workflowId: workflow.id,
            },
          },
        });
        if (existing) {
          dispatch = existing;
        } else {
          console.error(`[DISPATCH] Failed to record dispatch ledger for workflow ${workflow.id}:`, upsertErr);
          outcomes.push({
            workflowId: workflow.id,
            workflowVersionId: version.id,
            dispatchId: "unknown",
            status: "FAILED",
            error: upsertErr instanceof Error ? upsertErr.message : String(upsertErr),
          });
          continue;
        }
      } else {
        console.error(`[DISPATCH] Failed to record dispatch ledger for workflow ${workflow.id}:`, upsertErr);
        outcomes.push({
          workflowId: workflow.id,
          workflowVersionId: version.id,
          dispatchId: "unknown",
          status: "FAILED",
          error: upsertErr instanceof Error ? upsertErr.message : String(upsertErr),
        });
        continue;
      }
    }

    // If filter did not pass, record FILTERED status and skip ignition
    if (!passesFilter) {
      outcomes.push({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        dispatchId: dispatch.id,
        status: "FILTERED",
      });
      continue;
    }

    // If this dispatch already started a run (e.g. QStash redelivery), do not create a duplicate run!
    if (dispatch.status === "STARTED" && dispatch.runId) {
      outcomes.push({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        dispatchId: dispatch.id,
        status: "SKIPPED_ALREADY_STARTED",
        runId: dispatch.runId,
      });
      continue;
    }

    // 4. Idempotent Ignition via Existing Workflow Engine
    try {
      const run = await startWorkflow(
        event.orgId,
        workflow.id,
        event.payload as unknown as Record<string, JsonValue>,
        {
          expectedVersionId: version.id,
          dispatchId: dispatch.id,
        },
      );

      outcomes.push({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        dispatchId: dispatch.id,
        status: "STARTED",
        runId: run.id,
      });
    } catch (ignitionErr) {
      const errorMessage = ignitionErr instanceof Error ? ignitionErr.message : String(ignitionErr);
      if (errorMessage.includes("DISPATCH_ALREADY_CLAIMED_OR_STARTED")) {
        // Concurrency Invariant (M4-REM-2): A concurrent worker already claimed or started this dispatch.
        // Recover the winning runId from the dispatch ledger instead of failing the dispatch!
        const winningDispatch = await (db as unknown as {
          workflowTriggerDispatch: {
            findUnique: (args: unknown) => Promise<{ id: string; runId: string | null } | null>;
          };
        }).workflowTriggerDispatch.findUnique({
          where: { id: dispatch.id },
        });

        outcomes.push({
          workflowId: workflow.id,
          workflowVersionId: version.id,
          dispatchId: dispatch.id,
          status: "SKIPPED_ALREADY_STARTED",
          runId: winningDispatch?.runId || undefined,
        });
        continue;
      }

      console.error(`[DISPATCH] Ignition failed for workflow ${workflow.id}:`, ignitionErr);

      await (db as unknown as {
        workflowTriggerDispatch: {
          update: (args: unknown) => Promise<unknown>;
        };
      }).workflowTriggerDispatch.update({
        where: { id: dispatch.id },
        data: {
          status: "FAILED",
          error: errorMessage,
        },
      });

      outcomes.push({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        dispatchId: dispatch.id,
        status: "FAILED",
        error: errorMessage,
      });
    }
  }

  return {
    eventId: event.eventId,
    eventType: canonicalTrigger,
    orgId: event.orgId,
    workflowEligible: true,
    matchedWorkflows: matchingWorkflows.length,
    outcomes,
  };
}

/**
 * Sweeper duty: claims a batch of pending domain outbox events and dispatches them.
 */
export async function processDomainEventOutbox(
  batchSize = 25,
): Promise<{ processed: number; successCount: number; failureCount: number }> {
  const { claimToken, events } = await claimDomainOutboxBatch(batchSize);

  let successCount = 0;
  let failureCount = 0;

  for (const event of events) {
    try {
      await dispatchDomainEvent(event);
      await completeDomainOutboxEvent(event.id, claimToken);
      successCount++;
    } catch (err) {
      console.error(`[DISPATCH] Failed processing event ${event.id}:`, err);
      await failDomainOutboxEvent(event.id, claimToken, err, event.attempts);
      failureCount++;
    }
  }

  return {
    processed: events.length,
    successCount,
    failureCount,
  };
}
