import { publishEvent } from "./queue";
import { EventType, EventPayloadMap } from "./schema";

/**
 * The payload each trigger is dispatched with.
 *
 * Derived from the fields the routing rules actually read rather than from the
 * event schemas, because a trigger is an *input* to the bus while an event is
 * its *output*. `TASK_CREATED` is the clearest case: the dispatcher
 * (src/lib/prisma/extended.ts) already interpolates the task title into a
 * subject and body, so the bus does not need the title itself.
 *
 * `TASK_UPDATED` and `TASK_DELETED` are listed because they are dispatched, but
 * note they have no routing rule below - see `dispatchEvent`.
 */
export type TriggerPayloads = {
  USER_SIGNED_UP: { orgId: string; userId: string };
  TASK_CREATED: {
    taskId: string;
    orgId: string;
    projectId: string;
    userId: string;
    subject: string;
    body: string;
  };
  TASK_UPDATED: {
    taskId: string;
    orgId: string;
    projectId: string;
    userId: string;
    subject: string;
    body: string;
  };
  TASK_DELETED: {
    taskId: string;
    orgId: string;
    projectId: string;
    userId: string;
    subject: string;
    body: string;
  };
  TASK_COMPLETED: { orgId: string; projectId: string; taskId: string };
  FILE_UPLOADED: { orgId: string; fileId: string; taskId: string };
  PROJECT_COMPLETED: { orgId: string; projectId: string };
  AI_SUMMARY_REQUESTED: { orgId: string; projectId: string };
  CRON_DAILY_DIGEST: { orgId: string; userId?: string };
};

/**
 * Payload shape a routing rule is allowed to author.
 *
 * Deliberately wider than `EventPayloadMap[EventType]`. The bus is a producer,
 * and `publishEvent` is the validating authority - it runs `schema.safeParse`
 * and throws on failure. A rule may legitimately author a superset of its
 * schema's fields: `SEND_WELCOME_EMAIL` is dispatched with a subject and body
 * that its schema does not declare, so Zod strips them at publish time.
 * Narrowing the type here to the schema would either force a schema change or
 * force a cast, and both would hide a real asymmetry instead of recording it.
 */
type AuthoredPayload = EventPayloadMap[EventType] & Record<string, unknown>;

/**
 * A routed event, keeping `type` correlated with its payload type so a rule
 * cannot emit, say, a `SEND_EMAIL` carrying a `PROCESS_FILE` body.
 */
type RoutedEvent = {
  [K in EventType]: { type: K; payload: AuthoredPayload };
}[EventType];

type EventHandler<T extends keyof TriggerPayloads> = (
  payload: TriggerPayloads[T],
) => RoutedEvent;

/**
 * Optional on purpose: a trigger may be dispatched without having a rule, and
 * that is a silent no-op rather than an error (see `dispatchEvent`). Modelling
 * absence here - instead of widening the index to `Record<string, ...>` - keeps
 * each rule's handler parameter correctly typed while still permitting the gap.
 */
type RoutingTable = {
  [T in keyof TriggerPayloads]?: EventHandler<T>[];
};

const EVENT_ROUTING: RoutingTable = {
  USER_SIGNED_UP: [
    (p) => ({
      type: "SEND_WELCOME_EMAIL",
      payload: {
        orgId: p.orgId,
        userId: p.userId,
        subject: "Welcome to Forge 🚀",
        body: "Let’s build something amazing.",
      },
    }),

    (p) => ({
      type: "CREATE_DEFAULT_ORG",
      payload: {
        orgId: p.orgId,
      },
    }),

    (p) => ({
      type: "ANALYTICS_EVENT",
      payload: {
        orgId: p.orgId,
        eventName: "USER_SIGNED_UP",
        metadata: {
          userId: p.userId,
        },
      },
    }),
  ],

  TASK_CREATED: [
    (p) => ({
      type: "EMBEDDING_REQUESTED",
      payload: {
        orgId: p.orgId,
        entityId: p.taskId,
        type: "TASK",
      },
    }),

    (p) => ({
      type: "ANALYTICS_EVENT",
      payload: {
        orgId: p.orgId,
        eventName: "TASK_CREATED",
        metadata: {
          taskId: p.taskId,
          projectId: p.projectId,
        },
      },
    }),

    (p) => ({
      type: "SEND_EMAIL",
      payload: {
        orgId: p.orgId,
        userId: p.userId,
        subject: p.subject,
        body: p.body,
      },
    }),
  ],

  TASK_COMPLETED: [
    (p) => ({
      type: "NOTIFY_PROJECT_OWNER",
      payload: {
        orgId: p.orgId,
        projectId: p.projectId,
      },
    }),

    (p) => ({
      type: "ANALYTICS_EVENT",
      payload: {
        orgId: p.orgId,
        eventName: "TASK_COMPLETED",
        metadata: {
          taskId: p.taskId,
        },
      },
    }),
  ],

  FILE_UPLOADED: [
    (p) => ({
      type: "PROCESS_FILE",
      payload: {
        orgId: p.orgId,
        fileId: p.fileId,
      },
    }),

    (p) => ({
      type: "EMBEDDING_REQUESTED",
      payload: {
        orgId: p.orgId,
        entityId: p.fileId,
        type: "ATTACHMENT",
      },
    }),
  ],

  PROJECT_COMPLETED: [
    (p) => ({
      type: "NOTIFY_PROJECT_OWNER",
      payload: {
        orgId: p.orgId,
        projectId: p.projectId,
      },
    }),

    (p) => ({
      type: "GENERATE_COMPLETION_REPORT",
      payload: {
        orgId: p.orgId,
        projectId: p.projectId,
      },
    }),

    (p) => ({
      type: "AI_SUMMARY_REQUESTED",
      payload: {
        orgId: p.orgId,
        projectId: p.projectId,
      },
    }),
  ],

  AI_SUMMARY_REQUESTED: [
    (p) => ({
      type: "ANALYTICS_EVENT",
      payload: {
        orgId: p.orgId,
        eventName: "AI_SUMMARY_TRIGGERED",
        metadata: {
          projectId: p.projectId,
        },
      },
    }),
  ],

  CRON_DAILY_DIGEST: [
    (p) => ({
      type: "SEND_EMAIL",
      payload: {
        orgId: p.orgId,
        userId: p.userId ?? "system",
        subject: "Daily Digest",
        body: "You have pending tasks today.",
      },
    }),

    (p) => ({
      type: "ANALYTICS_EVENT",
      payload: {
        orgId: p.orgId,
        eventName: "CRON_DIGEST_SENT",
        metadata: {},
      },
    }),
  ],
};

/**
 * Fan a trigger out to every job its rules produce.
 *
 * A trigger with no rule is a no-op, not an error: `TASK_UPDATED` and
 * `TASK_DELETED` are dispatched by the Prisma extension but have no routing
 * entry, so today a task edit or delete produces no event at all. That is a real
 * gap - the vector index goes stale on every update - but it is a product
 * decision rather than a type error, so it is left visible here instead of
 * being papered over with a cast.
 *
 * `Promise.allSettled` is deliberate: one failing job must not stop the others.
 */
export async function dispatchEvent<T extends keyof TriggerPayloads>(
  trigger: T,
  payload: TriggerPayloads[T],
) {
    const handlers = EVENT_ROUTING[trigger];

    if (!handlers) return;

    const results = await Promise.allSettled(
        handlers.map((handlerFn) => {
            const job = handlerFn(payload);
            return publishEvent(job.type, job.payload);
        })
    );

    // Log errors for failed jobs so they don't disappear into the void
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.error(
                `Event failed at index ${index} for trigger "${trigger}":`, 
                result.reason
            );
            //sentry later

            }
    });
}