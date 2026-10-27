import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createWorker } from "@/lib/events/worker";
import { EventTypes } from "@/lib/events/schema";
import { fileWorkerHandler } from "@/app/api/worker/file-worker/fw";
import { emailWorkerHandler } from "@/app/api/worker/email-worker/ew";
import { cronWorkerHandler } from "@/app/api/worker/cron-worker/cw";
import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { taskDeletedWorkerHandler } from "@/app/api/worker/embedding-worker/task-deleted";
import { domainCleanupWorkerHandler } from "@/app/api/worker/embedding-worker/domain-cleanup";
import { handleDomainMaintenance } from "./domain-maintenance/dm";
import { handleAgentLoop } from "./agent-loop/al";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { handleAgentMaintenance } from "./agent-maintenance/am";
import { handleWorkflowMaintenance } from "./workflow-maintenance/wm";
import { handleWorkflowEvent } from "@/app/api/workflow/wf";


const handleFileUpload = createWorker("FILE_UPLOADED", fileWorkerHandler);
const handleEmail = createWorker("SEND_EMAIL", emailWorkerHandler);
const handleCron = createWorker("CRON_DAILY_DIGEST", cronWorkerHandler);
// 2. Create the CDC Workers routing to the single Idempotent handler
// FIX: Point the EMBEDDING_REQUESTED event directly to our Gemini worker
const handleEmbedding = createWorker("EMBEDDING_REQUESTED", embeddingWorkerHandler);
const handleTaskDeleted = createWorker("TASK_DELETED", taskDeletedWorkerHandler);
const handleDomainCleanup = createWorker("DOMAIN_CLEANUP_REQUESTED", domainCleanupWorkerHandler);
const handleDomainMaintenanceEvent = createWorker("DOMAIN_MAINTENANCE_REQUESTED", handleDomainMaintenance);
const handleAgentLoopEvent = createWorker("AGENT_LOOP_REQUESTED", handleAgentLoop);

// With USE_MULTI_TOPICS = false every event is published to the single "events"
// topic, so this route is the only consumer we can guarantee in source.
//
// AGENT_TOOL_EXECUTION_REQUESTED is dispatched here explicitly. The previous
// dedicated /api/worker/agent-tool-execution route was removed: keeping it
// alongside this dispatcher left two source-level consumers for one event, and
// the dedicated path could only ever receive traffic from an external QStash
// consumer that cannot be verified from the repo. If a QStash consumer is
// currently pointed at that URL it must be repointed at /api/worker.
const handleAgentToolExecution = createWorker(
  "AGENT_TOOL_EXECUTION_REQUESTED",
  handleToolExecution,
);

// Scheduled upkeep. Published by a QStash SCHEDULE (not by the app, and not by a
// platform cron) to the same /api/worker endpoint, so it is signed and recorded
// exactly like every other job and needs no separate authentication scheme.
const handleAgentMaintenanceEvent = createWorker(
  "AGENT_MAINTENANCE_REQUESTED",
  handleAgentMaintenance,
);

// Scheduled workflow upkeep. Kept separate from the agent sweep on purpose: this
// one can FAIL a step whose external side effect is unknowable, which is a
// different risk class from closing an abandoned session, and the two duties
// need to be independently scheduled and independently switched off.
const handleWorkflowMaintenanceEvent = createWorker(
  "WORKFLOW_MAINTENANCE_REQUESTED",
  handleWorkflowMaintenance,
);

// The workflow engine's own two events.
//
// These are published to the same single "events" topic as everything else,
// and with USE_MULTI_TOPICS=false that topic has exactly one endpoint - this
// route. They used to be handled only at /api/workflow, a URL that nothing
// publishes to, so every delivery arrived here, hit the "known event with no
// handler" branch, and was answered with a 500 that QStash retried three times
// before abandoning it. The run then sat at RUNNING with its step PENDING for
// ever: no workflow could execute a single step.
//
// The handlers are shared with /api/workflow, which keeps its dedicated
// endpoint. They are NOT wrapped in `createWorker`: their status codes are the
// engine's control channel, and a retriable step failure must answer 500 so
// QStash redelivers it.
//
// The signature check is applied HERE, explicitly, because this dispatcher does
// not verify at the top level - each branch verifies its own delivery. Without
// it these two events would be the only ones on this route that an
// unauthenticated caller could drive, and they are the ones that run real
// actions and mutate real workflow state.
const handleWorkflowEngineEvent = verifySignatureAppRouter(handleWorkflowEvent);

const knownEventTypes = new Set<string>(EventTypes);

/**
 * Is this a QStash signature rejection?
 *
 * `verifySignatureAppRouter` throws a `SignatureError` when the delivery cannot be
 * authenticated. The outer catch used to turn that into a 500, which is wrong in a
 * way that costs real money: QStash retries every 5xx, so a forged or
 * misconfigured delivery would be retried against its full budget against a
 * request that can never succeed. Worse, it reported an infrastructure fault
 * ("Router failed") for what is an authentication decision, so the real cause was
 * invisible in the response and only appeared in logs.
 *
 * 401 is the honest answer and the non-retryable one. Genuine transient
 * infrastructure failures still return 500 and still get retried, which is what
 * the retry budget is actually for.
 */
function isSignatureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.name === "SignatureError" ||
    error.constructor?.name === "SignatureError" ||
    /signature|jwt|jws|compact/i.test(error.message)
  );
}

export async function POST(req: NextRequest) {
  try {
    const clonedReq = req.clone();
    const body = await clonedReq.json();
    const { type } = body;

    if (!type) {
      return NextResponse.json({ error: "Missing event type" }, { status: 400 });
    }

    // -----------------------------
    // MAIN DISPATCHER
    // -----------------------------
    switch (type) {
      case "FILE_UPLOADED":

        return await handleFileUpload(req);

      case "SEND_EMAIL":
        return await handleEmail(req);

      case "TASK_DELETED":
        return await handleTaskDeleted(req);

      case "DOMAIN_CLEANUP_REQUESTED":
        return await handleDomainCleanup(req);

      case "DOMAIN_MAINTENANCE_REQUESTED":
        return await handleDomainMaintenanceEvent(req);

      case "EMBEDDING_REQUESTED":
        return await handleEmbedding(req);

      case "CRON_DAILY_DIGEST":
        return await handleCron(req);

      case "AGENT_LOOP_REQUESTED":
        return await handleAgentLoopEvent(req);

      case "AGENT_TOOL_EXECUTION_REQUESTED":
        return await handleAgentToolExecution(req);

      case "AGENT_MAINTENANCE_REQUESTED":
        return await handleAgentMaintenanceEvent(req);

      case "WORKFLOW_MAINTENANCE_REQUESTED":
        return await handleWorkflowMaintenanceEvent(req);

      // The engine's own events. They arrive here because this is the only
      // endpoint the "events" topic delivers to.
      case "EXECUTE_WORKFLOW_NODE":
      case "ADVANCE_WORKFLOW":
        return await handleWorkflowEngineEvent(req);

      default: {
        // Never acknowledge work we did not do.
        //
        // A known event with no handler here means this route is misrouted,
        // which is exactly the failure that previously produced a 200 for an
        // event nobody processed. 5xx so QStash retries.
        if (knownEventTypes.has(type)) {
          console.error(`[WORKER] No handler configured for known event: ${type}`);
          return NextResponse.json(
            { error: `No handler configured for event: ${type}` },
            { status: 500 },
          );
        }

        // An event we do not even know about. 4xx: retrying cannot help and
        // would burn the retry budget forever, but it must not look like work.
        console.warn(`[WORKER] Unknown event type: ${type}`);
        return NextResponse.json(
          { error: `Unknown event type: ${type}` },
          { status: 400 },
        );
      }
    }
  } catch (error) {
    if (isSignatureError(error)) {
      // Deliberately terse. The reason a signature failed is exactly the
      // information an attacker probing this endpoint wants back.
      console.error("[WORKER] Rejected an unauthenticated delivery.");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.error("❌ ROUTER FATAL ERROR:", error);
    return NextResponse.json({ error: "Router failed" }, { status: 500 });
  }
}
