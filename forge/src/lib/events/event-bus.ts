import OrgLayout from "@/app/org/[orgId]/layout";
import { publishEvent } from "./queue";
import { EventPayloadMap, EventType } from "./schema";

// Define all system-level triggers → jobs mapping
type EventHandler = (payload: any) => {
    type: EventType;
    payload: any;
};

const EVENT_ROUTING: Record<string, EventHandler[]> = {
   
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

  // -----------------------------------
  // TASK CREATED
  // -----------------------------------
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

    (payload) => ({
            type: "SEND_EMAIL",
            payload: {
                orgId: payload.orgId,
                userId: payload.userId,
                subject: "New Task Added",
                body: `A new task "${payload.title}" has been added to your project.`,
            },
        }),
  ],

  // -----------------------------------
  // TASK COMPLETED
  // -----------------------------------
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

  // -----------------------------------
  // FILE UPLOADED
  // -----------------------------------
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

  // -----------------------------------
  // PROJECT COMPLETED
  // -----------------------------------
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

  // -----------------------------------
  // AI SUMMARY REQUESTED (CHAINING)
  // -----------------------------------
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

  // -----------------------------------
  // CRON EVENT (OPTIONAL FAN-OUT)
  // -----------------------------------
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


export async function dispatchEvent<K extends keyof typeof EVENT_ROUTING>(trigger: K, payload: Parameters<typeof EVENT_ROUTING[K][number]>[0]) {
    const handlers = EVENT_ROUTING[trigger];

    if (!handlers) return;

    await Promise.all(
        handlers.map((handlerFn) => {
            // 1. Run the function to get the "Job" object
            const job = handlerFn(payload);

            // 2. Now 'job' has the 'type' and 'payload' properties
            return publishEvent(job.type, job.payload);
        })
    );
}