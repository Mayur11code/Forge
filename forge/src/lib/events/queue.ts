import { Client } from "@upstash/qstash";
import crypto from "crypto";
import {
  EventType,
  eventSchemas,
  EventPayloadMap,
} from "./schema";

/**
 * Upstash is multi-region and the SDK's default endpoint is eu-central-1.
 *
 * Omitting `baseUrl` does not degrade gracefully against a token from another
 * region: it returns a 404 whose body reads `user (...) not found in this region
 * (eu-central-1)`, which looks like a revoked or mistyped credential. QSTASH_URL
 * is required rather than optional for that reason - the failure mode of leaving
 * it unset is a genuinely misleading error.
 *
 * Built on first use rather than at module scope so the env is read at publish
 * time and so the error surfaces from the call the developer actually made.
 */
function getQStashClient() {
  if (!process.env.QSTASH_TOKEN) {
    throw new Error("Missing QSTASH_TOKEN");
  }

  if (!process.env.QSTASH_URL) {
    throw new Error(
      "Missing QSTASH_URL. Upstash is multi-region and the default endpoint " +
        "(eu-central-1) will reject this token with a confusing 404. Copy " +
        "the base URL from the QStash console.",
    );
  }

  return new Client({
    token: process.env.QSTASH_TOKEN,
    baseUrl: process.env.QSTASH_URL,
  });
}

const USE_MULTI_TOPICS = false;


const topicMap: Record<EventType, string> = {
  TASK_CREATED: "task-created",
  TASK_COMPLETED: "task-completed",
  TASK_UPDATED: "task-updated",
  TASK_DELETED: "task-deleted",
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
  EXECUTE_WORKFLOW_NODE: "execute-workflow-node",
  ADVANCE_WORKFLOW: "advance-workflow",
  WORKFLOW_MAINTENANCE_REQUESTED: "workflow-maintenance-requested",
    AGENT_LOOP_REQUESTED: "agent-loop-requested",
  AGENT_TOOL_EXECUTION_REQUESTED: "agent-tool-execution-requested",
  AGENT_MAINTENANCE_REQUESTED: "agent-maintenance-requested",
};

export function getTopic(event: EventType): string {
  if (USE_MULTI_TOPICS) {
    return topicMap[event];
  }

  // Free tier fallback
  return "events";
}


function buildCloudEvent<K extends EventType>(
  eventName: K,
  payload: EventPayloadMap[K],
  idOverride?: string,
) {
  const prefixId = 'orgId' in payload 
    ? payload.orgId 
    : ('runId' in payload ? payload.runId : 'system');
  return {
    specversion: "1.0",
    // `idOverride` exists for the agent transactional outbox. The default below
    // embeds Date.now(), which makes every publish distinct and therefore makes
    // republishing the same logical event undetectable to the broker or to a
    // consumer comparing cloud-event ids. The outbox supplies a deterministic
    // id derived from the durable outbox row instead, so a retry after a crash
    // is recognisably the same event rather than a new one.
    id: idOverride ?? `${prefixId}-${eventName}-${Date.now()}`,
    type: eventName,
    source: "engineered-forge",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: payload,
  };
}

export interface PublishOptions {
  /**
   * Deterministic cloud-event id. Required for outbox-driven publishes so a
   * redelivery is distinguishable from a distinct event.
   */
  messageId?: string;
  /**
   * Deterministic QStash deduplication id. Within QStash's dedup window the
   * broker itself drops a repeat publish, which is a second layer of defence
   * on top of the consumers' own CAS guards.
   */
  deduplicationId?: string;
}

/**
 * A caller-friendly delay such as "30s", "5m", "2h", "1d".
 *
 * Kept as a string because that is what every call site naturally writes, and
 * converted to seconds before it reaches QStash. The conversion is explicit
 * rather than a cast: QStash's `delay` is a number of seconds, so passing the
 * string through would have been rejected at runtime by the client. The
 * `as const` on the format below means an unrecognised unit is a compile error.
 */
export type PublishDelay = `${bigint}s` | `${bigint}m` | `${bigint}h` | `${bigint}d`;

const DELAY_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
};

function toDelaySeconds(delay: PublishDelay): number {
  const match = /^(\d+)([smhd])$/.exec(delay);

  if (!match) {
    throw new Error(
      `Invalid delay "${delay}". Expected a whole number followed by s, m, h or d.`,
    );
  }

  const [, value, unit] = match;

  return Number(value) * DELAY_UNITS[unit];
}

// main publishing
export async function publishEvent<K extends EventType>(
  eventName: K,
  payload: EventPayloadMap[K],
  delay?: PublishDelay,
  options?: PublishOptions,
) {
  if (!process.env.QSTASH_TOKEN) {
    throw new Error("Missing QSTASH_TOKEN");
  }

  // const topic = topicMap[eventName];
  const topic = getTopic(eventName);
  if (!topic) {
    throw new Error(`No topic configured for event: ${eventName}`);
  }

  // Built before the try so a configuration fault surfaces with its own message.
  // Inside it, the catch rewrites everything to "Failed to queue background job",
  // which would turn a missing region into an unactionable dead end - the whole
  // point of validating QSTASH_URL is to avoid that misdiagnosis.
  const client = getQStashClient();

  const schema = eventSchemas[eventName];
  const validatedPayload = schema.safeParse(payload);

  if (!validatedPayload.success) {
    throw new Error(`Invalid payload for event: ${eventName}`);
  }


  const cloudEvent = buildCloudEvent(
    eventName,
    validatedPayload.data as EventPayloadMap[K],
    options?.messageId,
  );


  const deduplicationId =
    options?.deduplicationId ??
    crypto
      .createHash("sha256")
      .update(JSON.stringify(cloudEvent))
      .digest("hex");

  // Derived from the client's own method signature rather than written as
  // `any`, so adding or renaming a publish option becomes a compile error here
  // instead of a silent runtime miss.
  type PublishJsonRequest = NonNullable<
    Parameters<Client["publishJSON"]>[0]
  >;

  const request: PublishJsonRequest = {
    topic,
    body: cloudEvent,
    retries: 3,
    deduplicationId,
  };

  if (delay) {
    // QStash expects SECONDS. The human-readable form is converted here rather
    // than forwarded, which the stricter request type now enforces.
    request.delay = toDelaySeconds(delay);
  }

  try {
    const res = await client.publishJSON(request);


    //i added this because i want to log the messageId of the published event for debugging purposes. 
    // The messageId is a unique identifier for the published message,
    //  and logging it can help track the event in QStash's dashboard 
    // and troubleshoot any issues that may arise with event processing.
    //but it can be an array if multiple messagens are published like in the case where 
    // we publish multiple events in a loop, so we need to handle both cases.
    
    const messageId = Array.isArray(res)
      ? res[0].messageId
      : res.messageId;

    
    console.log(" EVENT PUBLISHED");
    console.log("Event:", eventName);
    console.log("Message ID:", messageId);
    console.log("Topic:", topic);
   

    return res;
  } catch (error) {
    console.error("❌ QSTASH PUBLISH ERROR:", error);
    throw new Error("Failed to queue background job.");
  }
}