// src/lib/workflow/validation/canonical-hash.ts
//
// F-03: Deterministic canonical hashing and integrity verification for workflow execution snapshots.

import crypto from "crypto";
import {
  WorkflowExecutionSnapshot,
  WorkflowExecutionSnapshotSchema,
  WorkflowActionManifestEntry,
} from "@/lib/workflow-types/snapshot";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/workflow-types/workflow";
import type { JsonValue } from "@/lib/workflow-types/type";

const SENSITIVE_KEY_PATTERN = /password|secret|token|apikey|authorization|auth|privatekey/i;

/**
 * Strips UI-only presentation properties and redacts sensitive raw values.
 */
function sanitizeConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, val] of Object.entries(config)) {
    // Exclude UI-only keys
    if (["position", "x", "y", "width", "height", "selected", "dragging"].includes(key)) {
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED_SECRET]";
    } else if (val !== undefined) {
      result[key] = val as JsonValue;
    }
  }
  return result;
}

/**
 * Deterministically normalizes a workflow step:
 * - Sorts `dependsOn` lexicographically (Forge dependencies are sets of step IDs)
 * - Sanitizes config
 * - Preserves execution semantics
 */
function normalizeStep(step: WorkflowStep): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    id: step.id,
    action: step.action,
    kind: step.kind,
    isCritical: Boolean(step.isCritical),
    dependsOn: [...step.dependsOn].sort(),
    config: sanitizeConfig(step.config || {}),
  };

  if (step.routingConditions && Object.keys(step.routingConditions).length > 0) {
    normalized.routingConditions = step.routingConditions;
  }

  return normalized;
}

/**
 * Deterministically normalizes a workflow definition:
 * - Normalizes steps
 * - Excludes UI-only properties (uiNodes, uiEdges, etc.)
 */
function normalizeDefinition(definition: WorkflowDefinition): Record<string, unknown> {
  const normalizedSteps: Record<string, unknown> = {};
  for (const [stepId, step] of Object.entries(definition.steps)) {
    normalizedSteps[stepId] = normalizeStep(step);
  }

  return {
    id: definition.id,
    name: definition.name,
    steps: normalizedSteps,
  };
}

/**
 * Normalizes action manifest entries:
 * - Sorted by stepId for determinism
 */
function normalizeActionManifest(
  manifest: WorkflowActionManifestEntry[],
): WorkflowActionManifestEntry[] {
  return [...manifest].sort((a, b) => a.stepId.localeCompare(b.stepId));
}

/**
 * Deterministic JSON serialization with lexicographical object key sorting.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalizeJson(item)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const parts: string[] = [];

  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined) {
      parts.push(JSON.stringify(key) + ":" + canonicalizeJson(val));
    }
  }

  return "{" + parts.join(",") + "}";
}

/**
 * Builds the canonical execution payload for hashing.
 */
export function buildCanonicalExecutionPayload(
  snapshot: WorkflowExecutionSnapshot,
): Record<string, unknown> {
  return {
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
    workflowId: snapshot.workflowId,
    workflowName: snapshot.workflowName,
    definition: normalizeDefinition(snapshot.definition),
    actionManifest: normalizeActionManifest(snapshot.actionManifest),
  };
}

/**
 * Computes the canonical SHA-256 hash for a workflow execution snapshot.
 * Returns `sha256:<hex>`.
 */
export function computeWorkflowDefinitionHash(
  snapshot: WorkflowExecutionSnapshot,
): string {
  const payload = buildCanonicalExecutionPayload(snapshot);
  const canonicalJson = canonicalizeJson(payload);
  const digest = crypto.createHash("sha256").update(canonicalJson).digest("hex");
  return `sha256:${digest}`;
}

export type SnapshotVerificationResult =
  | { valid: true; snapshot: WorkflowExecutionSnapshot }
  | {
      valid: false;
      error: string;
      code: "MISSING_SNAPSHOT" | "CORRUPTED_ENVELOPE" | "HASH_MISMATCH" | "MALFORMED_DEFINITION";
    };

/**
 * Verifies the integrity of a workflow execution snapshot against an expected canonical hash.
 */
export function verifyWorkflowSnapshotIntegrity(
  rawSnapshot: unknown,
  expectedHash?: string | null,
): SnapshotVerificationResult {
  if (!rawSnapshot) {
    return {
      valid: false,
      error: "Workflow execution snapshot is missing or null",
      code: "MISSING_SNAPSHOT",
    };
  }

  const parsed = WorkflowExecutionSnapshotSchema.safeParse(rawSnapshot);
  if (!parsed.success) {
    return {
      valid: false,
      error: `Workflow execution snapshot envelope is corrupted: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      code: "CORRUPTED_ENVELOPE",
    };
  }

  const snapshot = parsed.data;

  if (!expectedHash) {
    return {
      valid: false,
      error: "Expected definitionHash is missing on workflow run",
      code: "HASH_MISMATCH",
    };
  }

  const computedHash = computeWorkflowDefinitionHash(snapshot);
  if (computedHash !== expectedHash) {
    return {
      valid: false,
      error: `Snapshot integrity check failed: hash mismatch (computed: ${computedHash}, expected: ${expectedHash})`,
      code: "HASH_MISMATCH",
    };
  }

  return { valid: true, snapshot };
}
