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