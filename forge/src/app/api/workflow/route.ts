// src/app/api/workflow/route.ts
//
// The workflow worker route. Handles two cloud events:
//
//   EXECUTE_WORKFLOW_NODE - run one step's action (or its compensation).
//   ADVANCE_WORKFLOW      - re-evaluate a run from a fresh read.
//
// Both are signed by QStash, so an unauthenticated caller cannot drive either.
//
// The handler itself lives in ./wf.ts, because these two events are published
// to the single "events" QStash topic, whose one endpoint is /api/worker.
// Keeping the handlers here alone made them reachable only at a URL that
// nothing publishes to: every delivery landed on /api/worker, which had no
// case for these event types, and the run never advanced. /api/worker now
// dispatches to the same handler, and this route keeps the dedicated
// endpoint.
//
// The status codes the handler returns are load-bearing. QStash deletes a
// message on 2xx and retries it on 5xx, so returning 200 for something that did
// not happen is the same as dropping it: a step that was never executed and a
// run that will never be re-evaluated both look identical to the broker from a
// "success" response. The rule the handler follows is that 2xx means the work
// is either done or durably scheduled, and 5xx means neither, and only the
// second case retries.

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { handleWorkflowEvent } from "./wf";

// Security: Wrap the handler with Upstash's signature verification
export const POST = verifySignatureAppRouter(handleWorkflowEvent);
