// FOR UI
//
// Presentation only. Everything semantic here — which inputs exist, which are
// required, which outputs a later step may reference — is DERIVED from the
// capability catalog (./action-capabilities.ts) rather than restated. This file
// owns what a widget looks like: widget type, label wording, dropdown option
// labels, and field order.
//
// Why the split (AD-P1): the capability catalog must be importable from client
// code with no server dependency, while the executable actions under
// src/lib/workflow/actions/** import the extended Prisma client and must never
// reach a browser bundle. Putting form widgets on the executable type would
// force one of those two to break. So there are three surfaces, each with one
// job:
//
//   action-registry.ts     which functions can run            (server, authority)
//   action-capabilities.ts what each action means             (shared, semantic)
//   registry.ts            how each action is presented       (client, this file)
//
// Every action id in this file is constrained to RegisteredActionId by
// `satisfies`, so the picker cannot offer an action the runtime cannot dispatch.
// `comment.add` was removed on exactly this rule: it was advertised here and
// registered nowhere, so a workflow using it saved and then failed at execution.

import { z } from "zod";
import {
  ActionCapabilities,
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
  type: 'string' | 'select' | 'textarea' | 'number';
  options?: { label: string; value: string }[]; 
  required: boolean;
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
    // When this event fires from EventBus, it will provide these variables
    outputs: ['taskId', 'projectId', 'assigneeId'] 
  },
  { 
    id: 'project.created', 
    label: 'On Project Created', 
    description: 'Triggers when a new project is initialized.',
    outputs: ['projectId'] 
  },
  { 
    id: 'user.joined', 
    label: 'On User Joined', 
    description: 'Triggers when an invitation is accepted.',
    outputs: ['userId', 'orgId', 'email'] 
  },
];


/**
 * Presentation overlay, keyed by catalogued action id.
 *
 * Deliberately partial and deliberately small: anything omitted falls back to a
 * value inferred from the schema. There is no `required` key here on purpose —
 * requiredness comes from the input schema and cannot be overridden by a widget
 * preference.
 */
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

/** Peel `.optional()` / `.default()` wrappers to find the real value type. */
function unwrapZod(field: z.ZodType): z.ZodType {
  let current = field;
  for (let i = 0; i < 10; i += 1) {
    const next = (current as { unwrap?: () => z.ZodType }).unwrap?.();
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Dropdown options derived from a Zod enum.
 *
 * Derived rather than typed out, so the picker cannot offer a value the input
 * schema would reject.
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

function inferWidget(field: z.ZodType): FieldDef["type"] {
  return unwrapZod(field) instanceof z.ZodEnum ? "select" : "string";
}

/**
 * Project one capability into the shape the canvas already consumes.
 *
 * `requires` and `outputs` are the two lists that matter downstream:
 * `getAvailableUpstreamOutputs` offers `outputs` as wireable values, and
 * `autoMapNodeVariables` / the missing-upstream alert read `requires`. Both are
 * computed here from the capability schemas, which is what corrects the old
 * `task.create` mismatch — it declared only `projectId` as required and only
 * `taskId` as an output, while the action actually needs `title` and publishes
 * `{ taskId, title }`.
 */
function buildActionDef(capability: ActionCapability): ActionDef {
  const required = new Set(requiredInputFields(capability.input));
  const presentation: Record<string, ActionFieldPresentation | undefined> =
    ACTION_FIELD_PRESENTATION[capability.id as RegisteredActionId] ?? {};

  const fields: FieldDef[] = inputFields(capability.input).map(
    ({ name, field }) => {
      const preset = presentation[name];
      return {
        name,
        label: preset?.label ?? name,
        type: preset?.type ?? inferWidget(field),
        options: preset?.options ?? enumOptions(field),
        required: required.has(name),
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
 *
 * Total by construction: there is no way to list an action here that has no
 * capability, and therefore none that has no executable registration.
 */
export const AVAILABLE_ACTIONS: ActionDef[] = Object.values(
  ActionCapabilities,
).map(buildActionDef);
