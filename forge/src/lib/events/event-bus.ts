import { publishEvent } from "./queue";
import { EventPayloadMap, EventType } from "./schema";

// Define all system-level triggers → jobs mapping
const EVENT_ROUTING: Record<string, EventType[]> = {
  USER_SIGNED_UP: [
    "SEND_WELCOME_EMAIL",
    "CREATE_DEFAULT_ORG",
    "ANALYTICS_EVENT",
  ],

  PROJECT_ADDED: [
    "SEND_EMAIL",
    "NOTIFY_PROJECT_OWNER",
    "GENERATE_COMPLETION_REPORT",
  ],
};

export async function dispatchEvent(
  trigger: keyof typeof EVENT_ROUTING,
  payload: any
) {
  const jobs = EVENT_ROUTING[trigger];

  if (!jobs) {
    console.warn(`[EventBus] No jobs mapped for trigger: ${trigger}`);
    return;
  }

  console.log(
    `[EventBus] ${trigger} → Dispatching ${jobs.length} jobs`
  );

  // 🔥 FAN-OUT (parallel dispatch)
  await Promise.all(
    jobs.map((jobName) =>
    
      publishEvent(jobName, payload)
    )
  );
}