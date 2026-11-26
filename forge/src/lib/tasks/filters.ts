// src/lib/tasks/filters.ts

import { TaskPriority, TaskStatus } from "@prisma/client";

/**
 * Narrows an untrusted query-string value to a member of a Prisma enum.
 *
 * Task list filters arrive as raw strings from the URL and were previously cast
 * with `as any` straight into the Prisma `where` clause. The cast compiles, and
 * Prisma rejects an unknown enum value at runtime - which means a hand-edited or
 * stale bookmark turns into a 500 on the org's task page rather than an empty
 * list or a redirect.
 *
 * Returns undefined for anything unrecognised, so the caller simply omits the
 * filter and shows the unfiltered list.
 *
 * `hasOwnProperty` rather than a truthy lookup: the enum object inherits from
 * Object.prototype, so `?status=constructor` would otherwise resolve to
 * something real and be handed to Prisma as a status.
 */
function toEnumMember<T extends Record<string, string>>(
  values: T,
  raw: string | undefined,
): T[keyof T] | undefined {
  if (raw === undefined || !Object.prototype.hasOwnProperty.call(values, raw)) {
    return undefined;
  }

  return values[raw as keyof T] as T[keyof T];
}

export function toTaskStatus(raw: string | undefined): TaskStatus | undefined {
  if (raw === "COMPLETED") {
    return TaskStatus.DONE;
  }
  return toEnumMember(TaskStatus, raw);
}

export function toTaskPriority(
  raw: string | undefined,
): TaskPriority | undefined {
  return toEnumMember(TaskPriority, raw);
}

/**
 * The task list carries two parameters that both address `status`: `status`, and
 * `filter`, which defaults to "ALL" meaning "no filter".
 *
 * The old query spread both, so whichever key came last won - and since `filter`
 * is always defined, the `status` parameter was silently ignored whenever it was
 * present. This resolves the precedence once, in one named place, rather than
 * relying on object-literal key order to express it. `filter` still wins, so
 * existing links behave exactly as they did.
 */
export function resolveTaskStatusFilter(params: {
  status?: string;
  filter?: string;
}): TaskStatus | undefined {
  return (
    toTaskStatus(params.filter !== "ALL" ? params.filter : undefined) ??
    toTaskStatus(params.status)
  );
}

/**
 * Resolves and validates an assignee filter against the organization's verified members.
 *
 * Enforces multi-tenant isolation and safe failure (P6):
 * - "UNASSIGNED" -> returns null (maps to { assigneeId: null } in Prisma).
 * - "ALL" or undefined -> returns undefined (no assignee filter applied).
 * - Valid member ID -> returns the userId string.
 * - Foreign or invalid member ID -> returns sentinel "INVALID_FOREIGN_ASSIGNEE" which
 *   safely matches 0 tasks rather than throwing or leaking tasks from other tenants.
 */
export function resolveTaskAssigneeFilter(
  rawAssignee: string | undefined,
  validMemberUserIds: Set<string> | string[]
): string | null | undefined {
  if (!rawAssignee || rawAssignee === "ALL") {
    return undefined;
  }

  if (rawAssignee === "UNASSIGNED") {
    return null;
  }

  const memberSet =
    validMemberUserIds instanceof Set
      ? validMemberUserIds
      : new Set(validMemberUserIds);

  if (memberSet.has(rawAssignee)) {
    return rawAssignee;
  }

  return "INVALID_FOREIGN_ASSIGNEE";
}
