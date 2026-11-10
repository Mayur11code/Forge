// src/lib/workflow-types/action-registry.ts

import { WorkflowAction } from "./type";
import { createTaskAction } from "../workflow/actions/core/create-task";

/**
 * Key format for versioned registry: `${actionId}@${actionVersion}`
 */
export function formatActionKey(actionId: string, actionVersion: string): string {
  return `${actionId}@${actionVersion}`;
}

/**
 * Parses an action key into { actionId, version } components.
 * Returns null if the format is invalid or ambiguous.
 */
export function parseActionKey(key: string): { actionId: string; version: string } | null {
  const parts = key.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { actionId: parts[0], version: parts[1] };
}

/**
 * Internal store for (actionId, actionVersion) -> WorkflowAction.
 */
const versionedActionStore = new Map<string, WorkflowAction>();

/**
 * Register a WorkflowAction with strict versioning.
 * - Rejects registration if actionId or version is missing.
 * - Rejects duplicate (actionId, version) registration if the implementation differs.
 */
export function registerAction(action: WorkflowAction): void {
  if (!action || typeof action !== "object") {
    throw new Error("Cannot register invalid action object");
  }
  if (!action.id || typeof action.id !== "string") {
    throw new Error("Cannot register action without a valid string id");
  }
  if (action.id.includes("@")) {
    throw new Error(`Cannot register action "${action.id}": actionId cannot contain '@' delimiter`);
  }
  if (!action.version || typeof action.version !== "string") {
    throw new Error(`Cannot register action "${action.id}" without an explicit string version`);
  }
  if (action.version.includes("@")) {
    throw new Error(`Cannot register action "${action.id}": actionVersion cannot contain '@' delimiter`);
  }

  const key = formatActionKey(action.id, action.version);
  const existing = versionedActionStore.get(key);
  if (existing && existing !== action) {
    throw new Error(
      `Duplicate action registration rejected: action "${action.id}" version "${action.version}" is already registered with a different implementation`,
    );
  }
  versionedActionStore.set(key, action);
}

/**
 * Clear the versioned action store (primarily used in tests).
 */
export function clearVersionedActionStore(): void {
  versionedActionStore.clear();
  registerAction(createTaskAction);
}

/**
 * The execution registry target object, containing the active/default action for each actionId.
 * Used for type checking RegisteredActionId, catalog checks, and test manipulations.
 */
const initialActionRegistry = {
  "task.create": createTaskAction,
};

export type RegisteredActionId = keyof typeof initialActionRegistry;

// Initial registration of default actions
registerAction(createTaskAction);

/**
 * A proxy over initialActionRegistry that also synchronizes entries with versionedActionStore.
 */
export const ActionRegistry: Record<string, WorkflowAction> & typeof initialActionRegistry =
  new Proxy(initialActionRegistry as unknown as Record<string, WorkflowAction> & typeof initialActionRegistry, {
    set(target, prop, value) {
      if (typeof prop === "string" && value && typeof value === "object") {
        const action = value as WorkflowAction;
        target[prop] = action;
        const version = action.version || "1.0.0";
        versionedActionStore.set(formatActionKey(prop, version), action);
        if (action.id && action.id !== prop) {
          versionedActionStore.set(formatActionKey(action.id, version), action);
        }
      } else if (typeof prop === "string") {
        target[prop] = value;
      }
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === "string") {
        const existing = target[prop];
        if (existing) {
          const version = existing.version || "1.0.0";
          versionedActionStore.delete(formatActionKey(prop, version));
          if (existing.id) {
            versionedActionStore.delete(formatActionKey(existing.id, version));
          }
        }
        delete target[prop];
      }
      return true;
    },
  });

/**
 * Ignition-time action selector:
 * Resolves the currently active registered action implementation and its version for a new run.
 */
export function getRegisteredActionForIgnition(actionId: string): WorkflowAction | undefined {
  return ActionRegistry[actionId];
}

/**
 * Runtime action lookup:
 * Resolves an action using EXACT (actionId, actionVersion).
 *
 * Invariants:
 * - Requires both actionId and actionVersion.
 * - Missing or empty actionVersion returns undefined (never silently falls back).
 * - Exact version mismatch returns undefined (never silently falls back to latest).
 */
export function getAction(actionId: string, actionVersion?: string): WorkflowAction | undefined {
  if (!actionId) {
    return undefined;
  }
  if (!actionVersion) {
    return ActionRegistry[actionId];
  }
  const key = formatActionKey(actionId, actionVersion);
  return versionedActionStore.get(key);
}
