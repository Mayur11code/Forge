// src/lib/events/domain-event-mapping.ts
//
// FC-017 / FC-018: Canonical Bidirectional Mapping between Domain Events & Workflow Triggers.

export const DOMAIN_EVENT_TO_TRIGGER_MAP = {
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  PROJECT_CREATED: "project.created",
} as const;

export const TRIGGER_TO_DOMAIN_EVENT_MAP = {
  "task.created": "TASK_CREATED",
  "task.updated": "TASK_UPDATED",
  "task.completed": "TASK_COMPLETED",
  "project.created": "PROJECT_CREATED",
} as const;

export type MappableDomainEventType = keyof typeof DOMAIN_EVENT_TO_TRIGGER_MAP;
export type MappableTriggerId = keyof typeof TRIGGER_TO_DOMAIN_EVENT_MAP;

export function mapDomainEventToTrigger(eventType: string): string | null {
  if (eventType in DOMAIN_EVENT_TO_TRIGGER_MAP) {
    return DOMAIN_EVENT_TO_TRIGGER_MAP[eventType as MappableDomainEventType];
  }
  // If already in dotted format:
  if (eventType in TRIGGER_TO_DOMAIN_EVENT_MAP) {
    return eventType;
  }
  return null;
}

export function mapTriggerToDomainEvent(triggerId: string): string | null {
  if (triggerId in TRIGGER_TO_DOMAIN_EVENT_MAP) {
    return TRIGGER_TO_DOMAIN_EVENT_MAP[triggerId as MappableTriggerId];
  }
  if (triggerId in DOMAIN_EVENT_TO_TRIGGER_MAP) {
    return triggerId;
  }
  return null;
}
