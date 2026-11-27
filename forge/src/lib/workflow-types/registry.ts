// FOR UI
//
// Presentation only. Everything semantic here — which inputs exist, which are
// required, which outputs a later step may reference — is DERIVED from the
// capability catalog (./action-capabilities.ts) rather than restated. This file
// owns what a widget looks like: widget type, label wording, dropdown option
// labels, and field order.

import { z } from "zod";
import {
  ActionCapabilities,
  getActionCapability,
  inputFields,
  referenceableOutputFields,
  requiredInputFields,
  type ActionCapability,
} from "./action-capabilities";
import type { RegisteredActionId } from "./action-registry";

// 1. Core Types for our I/O System
export type FieldDef = {
  name: string;
  label: string;
  type: 'string' | 'select' | 'textarea' | 'number' | 'boolean' | 'unsupported';
  options?: { label: string; value: string }[];
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  unsupportedReason?: string;
};

export type TriggerDef = {
  id: string;
  label: string;
  description: string;
  outputs: string[]; // Variables this trigger injects into the flow
};

export type ActionDef = {
  id: string;
  label: string;
  description: string;
  requires: string[];
  outputs: string[];
  fields: FieldDef[]; // The UI form fields
};

export const AVAILABLE_TRIGGERS: TriggerDef[] = [
  {
    id: 'task.created',
    label: 'On Task Created',
    description: 'Triggers when a new task is added.',
    outputs: ['taskId', 'projectId', 'title', 'description', 'priority', 'status', 'assigneeId'],
  },
  {
    id: 'task.updated',
    label: 'On Task Updated',
    description: 'Triggers when a task is modified.',
    outputs: ['taskId', 'projectId', 'title', 'description', 'priority', 'status', 'assigneeId', 'previousStatus'],
  },
  {
    id: 'task.completed',
    label: 'On Task Completed',
    description: 'Triggers when a task transitions to DONE.',
    outputs: ['taskId', 'projectId', 'title', 'completedAt'],
  },
  {
    id: 'project.created',
    label: 'On Project Created',
    description: 'Triggers when a new project is initialized.',
    outputs: ['projectId', 'name', 'description'],
  },
  {
    id: 'user.joined',
    label: 'On User Joined',
    description: 'Triggers when an invitation is accepted.',
    outputs: ['userId', 'orgId', 'email'],
  },
];

type ActionFieldPresentation = {
  label: string;
  type: FieldDef["type"];
  options?: FieldDef["options"];
};

const ACTION_FIELD_PRESENTATION = {
  "task.create": {
    title: { label: "Task Title", type: "string" },
    description: { label: "Task Description", type: "textarea" },
    priority: { label: "Priority", type: "select" },
  },
} satisfies Partial<
  Record<RegisteredActionId, Record<string, ActionFieldPresentation>>
>;

/** Peel `.optional()` / `.default()` / `.nullable()` wrappers to find the real value type. */
function unwrapZod(field: z.ZodType): z.ZodType {
  let current = field;
  for (let i = 0; i < 10; i += 1) {
    const next: z.ZodType | undefined = (current as { unwrap?: () => z.ZodType }).unwrap?.();
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/** Extract default value if the field (or an outer wrapper) is a ZodDefault. */
function extractDefaultValue(field: z.ZodType): unknown {
  let current: unknown = field;
  for (let i = 0; i < 10; i += 1) {
    if (current instanceof z.ZodDefault) {
      const def = (current as unknown as { _zod?: { def?: { defaultValue?: unknown } }; _def?: { defaultValue?: unknown | (() => unknown) } });
      if (def._zod?.def && "defaultValue" in def._zod.def) {
        return def._zod.def.defaultValue;
      }
      if (def._def && "defaultValue" in def._def) {
        const dv = def._def.defaultValue;
        return typeof dv === "function" ? (dv as () => unknown)() : dv;
      }
    }
    const next: z.ZodType | undefined = (current as { unwrap?: () => z.ZodType })?.unwrap?.();
    if (!next || next === current) break;
    current = next;
  }
  return undefined;
}

/** Extract description from `.describe(...)` across wrappers. */
function extractDescription(field: z.ZodType): string | undefined {
  let current: z.ZodType | undefined = field;
  for (let i = 0; i < 10 && current; i += 1) {
    if (typeof current.description === "string" && current.description.length > 0) {
      return current.description;
    }
    const next: z.ZodType | undefined = (current as { unwrap?: () => z.ZodType }).unwrap?.();
    if (!next || next === current) break;
    current = next;
  }
  return undefined;
}

/**
 * Dropdown options derived from a Zod enum.
 */
function enumOptions(field: z.ZodType): FieldDef["options"] | undefined {
  const core = unwrapZod(field);
  if (!(core instanceof z.ZodEnum)) return undefined;
  const values = (core as unknown as { options: readonly string[] }).options;
  return values.map((value) => ({
    value,
    label: value.charAt(0) + value.slice(1).toLowerCase(),
  }));
}

function inferWidget(field: z.ZodType): {
  type: FieldDef["type"];
  unsupportedReason?: string;
} {
  const core = unwrapZod(field);
  if (core instanceof z.ZodEnum) return { type: "select" };
  if (core instanceof z.ZodNumber) return { type: "number" };
  if (core instanceof z.ZodBoolean) return { type: "boolean" };
  if (core instanceof z.ZodString) return { type: "string" };
  return {
    type: "unsupported",
    unsupportedReason: `Unsupported schema type "${core.constructor.name}" cannot be rendered as a form input.`,
  };
}

function buildActionDef(capability: ActionCapability): ActionDef {
  const required = new Set(requiredInputFields(capability.input));
  const presentation: Record<string, ActionFieldPresentation | undefined> =
    ACTION_FIELD_PRESENTATION[capability.id as RegisteredActionId] ?? {};

  const fields: FieldDef[] = inputFields(capability.input).map(
    ({ name, field }) => {
      const preset = presentation[name];
      const inferred = inferWidget(field);
      const type =
        inferred.type === "unsupported"
          ? "unsupported"
          : (preset?.type ?? inferred.type);

      return {
        name,
        label: preset?.label ?? name,
        type,
        options: preset?.options ?? enumOptions(field),
        required: required.has(name),
        description: extractDescription(field),
        defaultValue: extractDefaultValue(field),
        unsupportedReason: inferred.unsupportedReason,
      };
    },
  );

  return {
    id: capability.id,
    label: capability.label,
    description: capability.description,
    requires: [...required],
    outputs: referenceableOutputFields(capability.output),
    fields,
  };
}

/**
 * The action picker's catalogue, projected from the capability catalog.
 */
export const AVAILABLE_ACTIONS: ActionDef[] = Object.values(
  ActionCapabilities,
).map(buildActionDef);

/**
 * Build initial config defaults for an action from its capability schema.
 */
export function getDefaultConfigForAction(actionId: string): Record<string, unknown> {
  const def = AVAILABLE_ACTIONS.find((a) => a.id === actionId);
  if (!def) return {};
  const defaults: Record<string, unknown> = {};
  for (const field of def.fields) {
    if (field.defaultValue !== undefined) {
      defaults[field.name] = field.defaultValue;
    }
  }
  return defaults;
}

export type FieldValidationIssue = {
  field: string;
  code:
    | "MISSING_REQUIRED_INPUT"
    | "INVALID_INPUT_TYPE"
    | "INVALID_VARIABLE_REFERENCE"
    | "UNSUPPORTED_SCHEMA";
  message: string;
};

const REFERENCE_TOKEN_REGEX = /\{\{([\w.-]+)\}\}/g;

/**
 * Validate an action node's config against its canonical Zod capability schema
 * AND check any `{{stepId.outputs.field}}` / `{{trigger.outputs.field}}` tokens
 * against actual upstream outputs.
 */
export function validateActionNodeConfig(
  actionId: string,
  config: Record<string, unknown> | undefined,
  upstreamOutputs: ReadonlyArray<{
    sourceNodeId: string;
    sourceNodeType?: "trigger" | "action";
    outputKey: string;
  }>,
): FieldValidationIssue[] {
  const capability = getActionCapability(actionId);
  const actionDef = AVAILABLE_ACTIONS.find((a) => a.id === actionId);
  if (!capability || !actionDef) return [];

  if (!(capability.input instanceof z.ZodObject)) {
    return [
      {
        field: "_schema",
        code: "UNSUPPORTED_SCHEMA",
        message: `Action "${actionId}" does not expose a ZodObject input schema.`,
      },
    ];
  }

  const issues: FieldValidationIssue[] = [];
  const shape = capability.input.shape as Record<string, z.ZodType>;
  const safeConfig = config ?? {};

  // Build lookup of valid canonical reference strings -> true
  const validRefs = new Set<string>();
  for (const out of upstreamOutputs) {
    const prefix = out.sourceNodeType === "trigger" ? "trigger" : out.sourceNodeId;
    validRefs.add(`${prefix}.outputs.${out.outputKey}`);
  }

  for (const fieldDef of actionDef.fields) {
    const fieldName = fieldDef.name;
    const fieldSchema = shape[fieldName];
    const rawValue = safeConfig[fieldName];

    if (fieldDef.type === "unsupported") {
      issues.push({
        field: fieldName,
        code: "UNSUPPORTED_SCHEMA",
        message: fieldDef.unsupportedReason || `Field "${fieldName}" has an unsupported schema.`,
      });
      continue;
    }

    const isEmpty =
      rawValue === undefined ||
      rawValue === null ||
      (typeof rawValue === "string" && rawValue.trim() === "");

    if (isEmpty) {
      if (fieldDef.required) {
        issues.push({
          field: fieldName,
          code: "MISSING_REQUIRED_INPUT",
          message: `${fieldDef.label} is required.`,
        });
      }
      continue;
    }

    if (typeof rawValue === "string") {
      // Check for malformed {{ or }} braces
      const stripped = rawValue.replace(REFERENCE_TOKEN_REGEX, "");
      if (stripped.includes("{{") || stripped.includes("}}")) {
        issues.push({
          field: fieldName,
          code: "INVALID_VARIABLE_REFERENCE",
          message: `Malformed variable reference in ${fieldDef.label}. Expected {{stepId.outputs.field}}.`,
        });
        continue;
      }

      const refs = [...rawValue.matchAll(REFERENCE_TOKEN_REGEX)].map((m) => m[1]);
      if (refs.length > 0) {
        let refFailed = false;
        for (const ref of refs) {
          const parts = ref.split(".");
          if (parts.length !== 3 || parts[1] !== "outputs") {
            issues.push({
              field: fieldName,
              code: "INVALID_VARIABLE_REFERENCE",
              message: `Invalid reference "{{${ref}}}". Canonical syntax is {{stepId.outputs.field}} or {{trigger.outputs.field}}.`,
            });
            refFailed = true;
            break;
          }
          if (!validRefs.has(ref)) {
            issues.push({
              field: fieldName,
              code: "INVALID_VARIABLE_REFERENCE",
              message: `Reference "{{${ref}}}" does not match any connected upstream output.`,
            });
            refFailed = true;
            break;
          }
        }
        if (refFailed) continue;

        // Valid variable reference: do not reject merely because the literal
        // `{{...}}` string does not match e.g. cuid/number/enum before runtime resolution.
        continue;
      }
    }

    // Literal value validation against the exact Zod field schema
    if (fieldSchema) {
      const parsed = fieldSchema.safeParse(rawValue);
      if (!parsed.success) {
        issues.push({
          field: fieldName,
          code: "INVALID_INPUT_TYPE",
          message: parsed.error.issues[0]?.message || `Invalid value for ${fieldDef.label}.`,
        });
      }
    }
  }

  return issues;
}
