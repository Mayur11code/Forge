import { Client } from "@upstash/qstash";
import crypto from "crypto";
import {
  EventType,
  eventSchemas,
  EventPayloadMap,
} from "./schema";

const qstashClient = new Client({
  token: process.env.QSTASH_TOKEN!,
});

const USE_MULTI_TOPICS = false;
// -----------------------------
// TOPIC MAP (EVENT → TOPIC)
// -----------------------------
const topicMap: Record<EventType, string> = {
  TASK_CREATED: "task-created",
  TASK_COMPLETED: "task-completed",
  FILE_UPLOADED: "file-uploaded",
  SEND_EMAIL: "send-email",
  PROCESS_FILE: "process-file",
  EMBEDDING_REQUESTED: "embedding-requested",
  AI_SUMMARY_REQUESTED: "ai-summary-requested",
  ANALYTICS_EVENT: "analytics-event",
  CRON_DAILY_DIGEST: "cron-daily-digest",
  NOTIFY_PROJECT_OWNER: "notify-project-owner",
  GENERATE_COMPLETION_REPORT: "generate-completion-report",
  
  CREATE_DEFAULT_ORG: "create-default-org",
  SEND_WELCOME_EMAIL: "send-welcome-email",
  EXECUTE_WORKFLOW_NODE: "execute-workflow-node"
};

export function getTopic(event: EventType): string {
  if (USE_MULTI_TOPICS) {
    return topicMap[event];
  }

  // Free tier fallback
  return "events";
}

// -----------------------------
// CLOUD EVENTS ENVELOPE
// -----------------------------
function buildCloudEvent<K extends EventType>(
  eventName: K,
  payload: EventPayloadMap[K]
) {
  const prefixId = 'orgId' in payload 
    ? payload.orgId 
    : ('runId' in payload ? payload.runId : 'system');
  return {
    specversion: "1.0",
    id: `${prefixId}-${eventName}-${Date.now()}`,
    type: eventName,
    source: "engineered-forge",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: payload,
  };
}

// -----------------------------
// MAIN PUBLISH FUNCTION
// -----------------------------
export async function publishEvent<K extends EventType>(
  eventName: K,
  payload: EventPayloadMap[K],
  delay?: `${number}s` | `${number}m` | `${number}h` | `${number}d`
) {
  if (!process.env.QSTASH_TOKEN) {
    throw new Error("Missing QSTASH_TOKEN");
  }

  // const topic = topicMap[eventName];
  const topic = getTopic(eventName);

  if (!topic) {
    throw new Error(`No topic configured for event: ${eventName}`);
  }

  // -----------------------------
  // VALIDATE PAYLOAD
  // -----------------------------
  const schema = eventSchemas[eventName];
  const validatedPayload = schema.safeParse(payload);

  if (!validatedPayload.success) {
    throw new Error(`Invalid payload for event: ${eventName}`);
  }

  // -----------------------------
  // BUILD CLOUDEVENT
  // -----------------------------
  const cloudEvent = buildCloudEvent(
    eventName,
    validatedPayload.data as EventPayloadMap[K]
  );
  // -----------------------------
  // PRODUCER IDEMPOTENCY KEY
  // -----------------------------
  const deduplicationId = crypto
    .createHash("sha256")
    .update(JSON.stringify(cloudEvent))
    .digest("hex");

  const request: any = {
    topic,
    body: cloudEvent,
    retries: 3,
    deduplicationId,
  };

  if (delay) {
    request.delay = delay;
  }

  try {
    const res = await qstashClient.publishJSON(request);


    //i added this because i want to log the messageId of the published event for debugging purposes. 
    // The messageId is a unique identifier for the published message,
    //  and logging it can help track the event in QStash's dashboard 
    // and troubleshoot any issues that may arise with event processing.
    //but it can be an array if multiple messagens are published like in the case where 
    // we publish multiple events in a loop, so we need to handle both cases.
    
    const messageId = Array.isArray(res)
      ? res[0].messageId
      : res.messageId;

    console.log("━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📡 EVENT PUBLISHED");
    console.log("Event:", eventName);
    console.log("Message ID:", messageId);
    console.log("Topic:", topic);
    console.log("━━━━━━━━━━━━━━━━━━━━━━");

    return res;
  } catch (error) {
    console.error("❌ QSTASH PUBLISH ERROR:", error);
    throw new Error("Failed to queue background job.");
  }
}