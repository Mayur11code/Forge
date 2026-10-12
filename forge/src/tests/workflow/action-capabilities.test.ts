// src/tests/workflow/action-capabilities.test.ts
//
// Assignment 37.1 — action capability catalog.
//
// Three surfaces have to stay in agreement, and this file is the runtime half
// of that guarantee (the compile-time half is `satisfies` in
// src/lib/workflow-types/action-capabilities.ts, verified separately):
//
//   action-registry.ts     which functions can run        (server authority)
//   action-capabilities.ts what each action means         (shared semantics)
//   registry.ts            how each action is presented   (client, picker)
//
// The tests that matter most are the ones that would fail if a field list went
// stale by hand. `requires` and `outputs` drive the canvas's auto-mapper and,
// from 37.3, reference validation — so a wrong list is a silent routing defect
// rather than a cosmetic bug.

import fs from "fs";
import path from "path";

import { z } from "zod";

// Importing the runtime registry pulls in the executable actions, which import
// the extended Prisma client and would construct a real client at module scope.
// jest.setup-db-guard.ts refuses that, correctly. The registry is needed here
// only for its KEY SET, never for a dispatched action, so the database modules
// are stubbed at the boundary rather than the registry being mocked away —
// mocking the registry would make the correspondence tests agree with a fake.
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import {
  CAPABILITY_ACTION_IDS,
  getActionCapability,
  inputFields,
  optionalInputFields,
  referenceableOutputFields,
  requiredInputFields,
} from "@/lib/workflow-types/action-capabilities";
import { ActionRegistry } from "@/lib/workflow-types/action-registry";
import {
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
  type ActionDef,
} from "@/lib/workflow-types/registry";
import { getNodeDefinition } from "@/lib/workflow/graph-ui/utils";
import { createTaskSchema } from "@/core/domain";
import type { ActionNodeData, TriggerNodeData } from "@/lib/workflow-types/workflow";

const FORGE_ROOT = path.resolve(__dirname, "../../..");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(FORGE_ROOT, relative), "utf8");
}

/** Import statements only, so comments mentioning a module do not count. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    specs.push(match[1]);
  }
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((match = bare.exec(source))) {
    specs.push(match[1]);
  }
  return specs;
}

function taskCreateActionDef(): ActionDef {
  const found = AVAILABLE_ACTIONS.find((a) => a.id === "task.create");
  if (!found) throw new Error("task.create is not in AVAILABLE_ACTIONS");
  return found;
}

function taskCreateCapability() {
  const cap = getActionCapability("task.create");
  if (!cap) throw new Error("task.create is not in the capability catalog");
  return cap;
}

describe("capability registry correspondence", () => {
  it("advertises exactly the actions the runtime registry can dispatch", () => {
    expect([...CAPABILITY_ACTION_IDS].sort()).toEqual(
      Object.keys(ActionRegistry).sort(),
    );
  });

  it("projects exactly the catalogued actions into the UI picker", () => {
    expect(AVAILABLE_ACTIONS.map((a) => a.id).sort()).toEqual(
      [...CAPABILITY_ACTION_IDS].sort(),
    );
  });

  it("has no duplicate action ids in any of the three surfaces", () => {
    expect(new Set(CAPABILITY_ACTION_IDS).size).toBe(
      CAPABILITY_ACTION_IDS.length,
    );
    expect(new Set(Object.keys(ActionRegistry)).size).toBe(
      Object.keys(ActionRegistry).length,
    );
    expect(new Set(AVAILABLE_ACTIONS.map((a) => a.id)).size).toBe(
      AVAILABLE_ACTIONS.length,
    );
  });

  it("gives every capability the metadata a planner needs", () => {
    for (const id of CAPABILITY_ACTION_IDS) {
      const cap = getActionCapability(id);
      expect(cap).toBeDefined();
      expect(cap!.id).toBe(id);
      expect(cap!.label.length).toBeGreaterThan(0);
      expect(cap!.description.length).toBeGreaterThan(0);
      expect(cap!.compensation).toBeDefined();
      expect(typeof cap!.compensation.available).toBe("boolean");
      expect(cap!.failure).toBeDefined();
      expect(typeof cap!.failure.notes).toBe("string");
      expect(cap!.failure.notes.length).toBeGreaterThan(0);
      expect(cap!.input).toBeInstanceOf(z.ZodType);
      expect(cap!.output).toBeInstanceOf(z.ZodType);
    }
  });

  it("refuses to derive fields from a schema it cannot read", () => {
    // The derivations throw rather than returning an empty list, because an
    // unreadable schema would make `requires` and `outputs` silently empty —
    // which is the exact defect the catalog exists to prevent.
    expect(() =>
      requiredInputFields(z.string()),
    ).toThrow(/must be a z\.object/);
    expect(() => referenceableOutputFields(z.string())).toThrow(
      /must be a z\.object/,
    );
  });
});

describe("client-safety of the capability modules", () => {
  const clientFacing = [
    "src/lib/workflow-types/action-capabilities.ts",
    "src/lib/workflow-types/registry.ts",
  ];

  const forbidden = [
    "@/lib/prisma/db",
    "@/lib/prisma/extended",
    "@prisma/client",
    "@/lib/redis",
    "@/lib/ai",
    "@/lib/workflow/actions",
    "@/lib/auth",
    "server-only",
  ];

  it.each(clientFacing)("imports nothing server-only from %s", (file) => {
    const specs = importSpecifiers(readSource(file));
    for (const spec of specs) {
      for (const bad of forbidden) {
        // `action-capabilities.ts` has one deliberate type-only import from the
        // runtime registry, which `isolatedModules` erases. Everything else is
        // a hard failure.
        if (file.endsWith("action-capabilities.ts") && spec === "./action-registry") {
          continue;
        }
        expect(spec.startsWith(bad)).toBe(false);
      }
    }
  });

  it("keeps the registry coupling type-only, so no runtime edge exists", () => {
    const source = readSource("src/lib/workflow-types/action-capabilities.ts");
    const specs = importSpecifiers(source);
    const registryImports = specs.filter((s) => s.includes("action-registry"));
    expect(registryImports).toHaveLength(1);
    expect(source).toMatch(
      /import\s+type\s*\{[^}]*RegisteredActionId[^}]*\}\s*from\s*["']\.\/action-registry["']/,
    );
  });

  it("does not import the executable action implementations", () => {
    for (const file of clientFacing) {
      const specs = importSpecifiers(readSource(file));
      expect(specs.filter((s) => s.includes("/workflow/actions/"))).toEqual([]);
      expect(specs.filter((s) => s.includes("create-task"))).toEqual([]);
    }
  });
});

describe("task.create input contract", () => {
  const cap = taskCreateCapability();

  it("requires title and projectId", () => {
    expect(requiredInputFields(cap.input).sort()).toEqual([
      "projectId",
      "title",
    ]);
  });

  it("treats description, assigneeId and priority as optional", () => {
    expect(optionalInputFields(cap.input).sort()).toEqual([
      "assigneeId",
      "description",
      "priority",
    ]);
  });

  it("matches the canonical createTaskSchema accept/reject behaviour", () => {
    // createTaskSchema (src/core/domain.ts:14) is the shared contract the
    // canonical operation validates with, so the catalog must agree with it on
    // every payload it can express. The one deliberate difference — strictness
    // — is asserted separately below.
    const cases: unknown[] = [
      { title: "Fix login redirect", projectId: "clxyz0000000000000000000a" },
      {
        title: "Fix login redirect",
        projectId: "clxyz0000000000000000000a",
        description: "details",
        assigneeId: "clxyz0000000000000000000b",
        priority: "HIGH",
      },
      { title: "ab", projectId: "clxyz0000000000000000000a" },
      { title: "x".repeat(101), projectId: "clxyz0000000000000000000a" },
      { title: "valid title", projectId: "not-a-cuid" },
      { title: "valid title" },
      { projectId: "clxyz0000000000000000000a" },
      { title: "valid title", projectId: "clxyz0000000000000000000a", priority: "URGENT" },
    ];

    for (const payload of cases) {
      expect(cap.input.safeParse(payload).success).toBe(
        createTaskSchema.safeParse(payload).success,
      );
    }
  });

  it("rejects unknown keys where the canonical schema strips them", () => {
    const payload = {
      title: "valid title",
      projectId: "clxyz0000000000000000000a",
      orgId: "attacker-controlled",
    };

    // The canonical schema is not strict, so it silently drops the extra key.
    // The capability boundary is strict on purpose: a typo or an attempt to
    // smuggle a trusted field must fail while the proposal is being generated,
    // not at execution time when the step is already persisted.
    expect(createTaskSchema.safeParse(payload).success).toBe(true);
    expect(cap.input.safeParse(payload).success).toBe(false);
  });

  it("rejects malformed values", () => {
    const base = { title: "valid title", projectId: "clxyz0000000000000000000a" };
    expect(cap.input.safeParse({ ...base, title: "ab" }).success).toBe(false);
    expect(
      cap.input.safeParse({ ...base, title: "x".repeat(101) }).success,
    ).toBe(false);
    expect(
      cap.input.safeParse({ ...base, projectId: "not-a-cuid" }).success,
    ).toBe(false);
    expect(cap.input.safeParse({ ...base, assigneeId: "nope" }).success).toBe(false);
    expect(cap.input.safeParse({ ...base, priority: "URGENT" }).success).toBe(false);
  });

  it("applies the documented MEDIUM default", () => {
    const parsed = cap.input.parse({
      title: "valid title",
      projectId: "clxyz0000000000000000000a",
    }) as { priority: string };
    expect(parsed.priority).toBe("MEDIUM");
  });

  it("declares LOW/MEDIUM/HIGH and nothing else", () => {
    const parsed = cap.input.safeParse({
      title: "valid title",
      projectId: "clxyz0000000000000000000a",
      priority: "MEDIUM",
    });
    expect(parsed.success).toBe(true);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(
      (parsed.data as { priority: string }).priority,
    );
  });

  it("exposes no trusted identity as a model-controlled input", () => {
    // AD-10: a capability is schema information, never execution authority.
    const shape = (cap.input as z.ZodObject<z.ZodRawShape>).shape;
    const names = Object.keys(shape);
    for (const trusted of ["orgId", "userId", "workflowId", "runId"]) {
      expect(names).not.toContain(trusted);
    }
    expect(cap.input.safeParse({
      title: "valid title",
      projectId: "clxyz0000000000000000000a",
      orgId: "org_attacker",
      userId: "user_attacker",
      workflowId: "wf_attacker",
      runId: "run_attacker",
    }).success).toBe(false);
  });
});

describe("task.create output contract", () => {
  const cap = taskCreateCapability();

  it("declares exactly the payload the action returns", () => {
    // createTaskAction returns { taskId, title } under ActionResult.data
    // (src/lib/workflow/actions/core/create-task.ts:68-71), which the wrapper
    // persists into StepRun.outputs and which `{{stepId.outputs.*}}` resolves
    // against. Declaring anything else would make a real output unreachable.
    expect(referenceableOutputFields(cap.output).sort()).toEqual([
      "taskId",
      "title",
    ]);
  });

  it("describes the business payload, not the ActionResult envelope", () => {
    const names = referenceableOutputFields(cap.output);
    expect(names).not.toContain("success");
    expect(names).not.toContain("data");
    expect(names).not.toContain("error");
    expect(names).not.toContain("isRetriable");
  });

  it("validates the real payload produced by the action", () => {
    expect(
      cap.output.safeParse({ taskId: "ckx00000000000000000000", title: "Hello" })
        .success,
    ).toBe(true);
    expect(
      cap.output.safeParse({ taskId: "ckx00000000000000000000" }).success,
    ).toBe(false);
    expect(
      cap.output.safeParse({ taskId: "ckx00000000000000000000", title: "t", extra: 1 })
        .success,
    ).toBe(true);
  });
});

describe("UI projection", () => {
  const def = taskCreateActionDef();

  it("derives requires from the capability input schema", () => {
    expect(def.requires.sort()).toEqual(["projectId", "title"]);
  });

  it("derives outputs from the capability output schema", () => {
    expect(def.outputs.sort()).toEqual(["taskId", "title"]);
  });

  it("offers every model-suppliable input as a form field", () => {
    expect(def.fields.map((f) => f.name).sort()).toEqual([
      "assigneeId",
      "description",
      "priority",
      "projectId",
      "title",
    ]);
  });

  it("derives requiredness rather than restating it", () => {
    const required = def.fields.filter((f) => f.required).map((f) => f.name);
    expect(required.sort()).toEqual(["projectId", "title"]);
  });

  it("derives select options from the enum so the picker cannot invent values", () => {
    const priority = def.fields.find((f) => f.name === "priority");
    expect(priority?.type).toBe("select");
    expect(priority?.options?.map((o) => o.value).sort()).toEqual([
      "HIGH",
      "LOW",
      "MEDIUM",
    ]);
  });

  it("keeps UI-only presentation under UI control", () => {
    const description = def.fields.find((f) => f.name === "description");
    expect(description?.type).toBe("textarea");
    const title = def.fields.find((f) => f.name === "title");
    expect(title?.type).toBe("string");
    expect(title?.label).toBe("Task Title");
  });

  it("does not advertise comment.add, which the runtime cannot dispatch", () => {
    expect(AVAILABLE_ACTIONS.map((a) => a.id)).not.toContain("comment.add");
    expect(ActionRegistry).not.toHaveProperty("comment.add");
    expect(getActionCapability("comment.add")).toBeUndefined();
  });

  it("does not advertise the unregistered on-disk implementations", () => {
    for (const id of ["communication.send_email", "utils.generate_report"]) {
      expect(AVAILABLE_ACTIONS.map((a) => a.id)).not.toContain(id);
      expect(ActionRegistry).not.toHaveProperty(id);
      expect(getActionCapability(id)).toBeUndefined();
    }
  });

  it("leaves trigger presentation unchanged", () => {
    expect(AVAILABLE_TRIGGERS.map((t) => t.id)).toEqual([
      "task.created",
      "project.created",
      "user.joined",
    ]);
    expect(AVAILABLE_TRIGGERS.map((t) => t.label)).toEqual([
      "On Task Created",
      "On Project Created",
      "On User Joined",
    ]);
    expect(AVAILABLE_TRIGGERS[0].outputs).toEqual([
      "taskId",
      "projectId",
      "assigneeId",
    ]);
  });

  it("resolves action and trigger node definitions for existing consumers", () => {
    const actionData: ActionNodeData = {
      label: "Create a Task",
      actionType: "task.create",
      config: {},
      isConfigured: false,
      isCritical: false,
    };
    const triggerData: TriggerNodeData = {
      label: "On Task Created",
      eventId: "task.created",
    };

    expect(getNodeDefinition({ type: "action", data: actionData })?.id).toBe(
      "task.create",
    );
    expect(getNodeDefinition({ type: "trigger", data: triggerData })?.id).toBe(
      "task.created",
    );
    expect(
      getNodeDefinition({
        type: "action",
        data: { ...actionData, actionType: "comment.add" },
      }),
    ).toBeUndefined();
    expect(
      getNodeDefinition({
        type: "action",
        data: { ...actionData, actionType: "" },
      }),
    ).toBeUndefined();
  });
});

describe("derivation cannot silently omit a field", () => {
  it("counts inputs and outputs from the schemas, not a side list", () => {
    const cap = taskCreateCapability();
    expect(inputFields(cap.input).map((f) => f.name).sort()).toEqual(
      Object.keys((cap.input as z.ZodObject<z.ZodRawShape>).shape).sort(),
    );
    expect(referenceableOutputFields(cap.output)).toHaveLength(
      Object.keys((cap.output as z.ZodObject<z.ZodRawShape>).shape).length,
    );
  });

  it("reflects a schema change immediately, with no second edit", () => {
    // Proves the derivation is live rather than a coincidence: mutating the
    // shape of a throwaway capability changes the derived lists, which is what
    // keeps `requires` and `outputs` honest when a real action gains a field.
    const mutated = z
      .object({ alpha: z.string(), beta: z.string().optional() })
      .strict();
    expect(requiredInputFields(mutated)).toEqual(["alpha"]);
    expect(optionalInputFields(mutated)).toEqual(["beta"]);
    expect(referenceableOutputFields(z.object({ gamma: z.string() }))).toEqual([
      "gamma",
    ]);
  });
});
