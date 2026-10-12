// src/tests/workflow/proposal-references.test.ts
//
// Assignment 37.3 - Reference grammar + validator.
//
// The validator is a second READER of the runtime resolver's grammar
// (src/lib/workflow/execution/resolver.ts), not a second grammar. These tests
// pin three things:
//
//   1. Which reference classes are accepted (existing step + declared output +
//      explicit dependsOn), and which are rejected with which code.
//   2. That the grammar the validator recognizes stays aligned with the real
//      `resolveInputs` behaviour, exercised directly.
//   3. That the resolver itself is untouched.
//
// Current catalogued actions declare flat, all-string outputs. The nested and
// array cases exist because the resolver walks nested payloads and
// `MAX_INPUT_DEPTH` bounds them (workflow-proposal.ts), so the validator must
// walk them too - it is defined over `WorkflowProposal`, whose `inputs` is an
// open `Record<string, unknown>`. Per-action input strictness is 37.2's job,
// not this validator's.

import { readFileSync } from "fs";
import { join, resolve } from "path";

import {
  RESERVED_REFERENCE_SOURCES,
  UNSAFE_REFERENCE_SEGMENTS,
  extractReferences,
  validateProposalReferences,
} from "@/lib/workflow-types/workflow-proposal-references";
import {
  getActionCapability,
  referenceableOutputFields,
} from "@/lib/workflow-types/action-capabilities";
import type {
  WorkflowProposal,
  WorkflowProposalStep,
} from "@/lib/workflow-types/workflow-proposal";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import type { JsonValue } from "@/lib/workflow-types/type";

const FORGE_ROOT = resolve(__dirname, "../../..");
const PROJECT_ID = "clxyz0000000000000000000a";

function readSource(relative: string): string {
  return readFileSync(join(FORGE_ROOT, relative), "utf8");
}

function createStep(
  overrides: Partial<WorkflowProposalStep> = {},
): WorkflowProposalStep {
  return {
    action: "task.create",
    inputs: { title: "Do the thing", projectId: PROJECT_ID },
    dependsOn: [],
    ...overrides,
  };
}

function proposal(steps: Record<string, WorkflowProposalStep>): WorkflowProposal {
  return { name: "Reference test", steps };
}

function issues(steps: Record<string, WorkflowProposalStep>) {
  return validateProposalReferences(proposal(steps));
}

function codes(list: ReturnType<typeof issues>) {
  return list.map((issue) => issue.code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

describe("validateProposalReferences - accepted references", () => {
  it("accepts a reference to a declared output on an existing step (whole value)", () => {
    const result = issues({
      a: createStep(),
      b: createStep({
        inputs: { title: "{{a.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("requires and accepts the source listed explicitly in dependsOn", () => {
    const result = issues({
      a: createStep(),
      b: createStep({
        inputs: { title: "{{a.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(codes(result)).not.toContain("MISSING_DATA_DEPENDENCY");
    expect(result).toEqual([]);
  });

  it("accepts multiple distinct valid references in one step", () => {
    const result = issues({
      a: createStep(),
      b: createStep(),
      c: createStep({
        inputs: {
          title: "{{a.outputs.title}}",
          description: "{{b.outputs.taskId}}",
          projectId: PROJECT_ID,
        },
        dependsOn: ["a", "b"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("accepts a valid reference nested inside an input object", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "T",
          projectId: PROJECT_ID,
          payload: { ref: "{{a.outputs.taskId}}" },
        },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("accepts a valid reference nested inside an array", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "T",
          projectId: PROJECT_ID,
          items: ["{{a.outputs.taskId}}", "literal"],
        },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("accepts a valid reference interpolated into a larger string", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "Task for {{a.outputs.title}} project",
          projectId: PROJECT_ID,
        },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("accepts a valid whole-string reference", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([]);
  });

  it("accepts ordinary strings that do not use reference syntax", () => {
    const result = issues({
      c: createStep({
        inputs: {
          title: "Review the invoice",
          description: "Use the standard template: { not a reference }",
          projectId: PROJECT_ID,
        },
      }),
    });
    expect(result).toEqual([]);
  });

  it("does not mutate the proposal (read-only, deep-frozen input)", () => {
    const frozen = deepFreeze(
      proposal({
        a: createStep(),
        c: createStep({
          inputs: {
            title: "{{a.outputs.title}}",
            projectId: PROJECT_ID,
            payload: ["{{missing.outputs.x}}"],
          },
          dependsOn: ["a"],
        }),
      }),
    );
    const before = JSON.stringify(frozen);
    expect(() => validateProposalReferences(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("source-step resolution", () => {
  it("rejects a reference to a step that is not in the proposal", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{missingStep.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([
      {
        code: "UNKNOWN_REFERENCE_SOURCE",
        path: "steps.c.inputs.title",
        message: expect.any(String),
      },
    ]);
  });

  it("rejects an out-of-scope runtime namespace as UNAVAILABLE_REFERENCE_SCOPE", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{organization.members}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["UNAVAILABLE_REFERENCE_SCOPE"]);
    expect(result[0].path).toBe("steps.c.inputs.title");
  });

  it("treats a step named like a reserved namespace as a step", () => {
    const result = issues({
      user: createStep({ inputs: { title: "Seed the account" } }),
      c: createStep({
        inputs: { title: "{{user.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["user"],
      }),
    });
    expect(result).toEqual([]);
  });
});

describe("output-path validation", () => {
  it("accepts exactly the fields the capability catalog declares", () => {
    const capability = getActionCapability("task.create");
    if (!capability) {
      throw new Error("task.create must be catalogued for this test");
    }
    const declared = referenceableOutputFields(capability.output);
    expect(declared.length).toBeGreaterThan(0);

    for (const field of declared) {
      const result = issues({
        a: createStep(),
        c: createStep({
          inputs: { title: `{{a.outputs.${field}}}`, projectId: PROJECT_ID },
          dependsOn: ["a"],
        }),
      });
      expect(result).toEqual([]);
    }
  });

  it("rejects an undeclared output field", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.outputs.secretField}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([
      {
        code: "UNKNOWN_OUTPUT",
        path: "steps.c.inputs.title",
        message: expect.any(String),
      },
    ]);
  });

  it("rejects a nested descendant of a primitive output", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.outputs.taskId.nested}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(codes(result)).toEqual(["UNKNOWN_OUTPUT"]);
  });

  it("rejects a reference with a wrong namespace after a valid step", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.config.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });

  it("rejects a reference missing the output field", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.outputs}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });
});

describe("explicit data dependency", () => {
  it("requires the referenced source in dependsOn (MISSING_DATA_DEPENDENCY)", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: [],
      }),
    });
    expect(result).toEqual([
      {
        code: "MISSING_DATA_DEPENDENCY",
        path: "steps.c.inputs.title",
        message: expect.any(String),
      },
    ]);
  });

  it("does not accept a transitive chain as a substitute for the direct dependency", () => {
    const result = issues({
      a: createStep(),
      b: createStep({ dependsOn: ["a"] }),
      c: createStep({
        inputs: { title: "{{a.outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["b"],
      }),
    });
    expect(codes(result)).toEqual(["MISSING_DATA_DEPENDENCY"]);
  });

  it("reports a self-reference rather than accepting it as a dependency", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{c.outputs.taskId}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["SELF_REFERENCE"]);
    expect(result[0].path).toBe("steps.c.inputs.title");
  });
});

describe("malformed and unsafe references", () => {
  it("rejects an incomplete reference delimiter", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{a.outputs.title", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });

  it("rejects an empty reference expression", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });

  it("rejects a reference with an empty path segment", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: { title: "{{a..outputs.title}}", projectId: PROJECT_ID },
        dependsOn: ["a"],
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });

  it("rejects prototype-sensitive path segments", () => {
    for (const segment of ["__proto__", "constructor", "prototype"]) {
      const result = issues({
        a: createStep(),
        c: createStep({
          inputs: {
            title: `{{a.outputs.${segment}}}`,
            projectId: PROJECT_ID,
          },
          dependsOn: ["a"],
        }),
      });
      expect(codes(result)).toEqual(["UNSAFE_REFERENCE_PATH"]);
    }
  });

  it("rejects a prototype segment in the source position before source lookup", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{__proto__.outputs.x}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["UNSAFE_REFERENCE_PATH"]);
  });

  it("exposes the protected segment list for inspection", () => {
    expect(UNSAFE_REFERENCE_SEGMENTS).toContain("__proto__");
    expect(RESERVED_REFERENCE_SOURCES).toContain("organization");
  });
});

describe("malformed delimiters", () => {
  it("rejects an incomplete opener the resolver would leave as literal text", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "before {{a.outputs.title", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });

  it("does not flag a single stray brace as a reference attempt", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "a single { brace }", projectId: PROJECT_ID },
      }),
    });
    expect(result).toEqual([]);
  });
});

describe("trigger references (fail closed)", () => {
  it("rejects any trigger output field because no static contract exists", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{trigger.outputs.userId}}", projectId: PROJECT_ID },
      }),
    });
    expect(result).toEqual([
      {
        code: "UNKNOWN_OUTPUT",
        path: "steps.c.inputs.title",
        message: expect.any(String),
      },
    ]);
    // Trigger is its own namespace: never a data dependency.
    expect(codes(result)).not.toContain("MISSING_DATA_DEPENDENCY");
  });

  it("rejects a trigger reference regardless of field name (fail closed)", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{trigger.outputs.anything}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["UNKNOWN_OUTPUT"]);
  });

  it("rejects a malformed trigger namespace", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{trigger.values.userId}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["MALFORMED_REFERENCE"]);
  });
});

describe("prototype-sensitive paths", () => {
  it("rejects every unsafe segment the grammar would otherwise allow", () => {
    for (const segment of ["__proto__", "prototype", "constructor"]) {
      expect(`{{a.outputs.${segment}}}`).toMatch(/\{\{[\w.-]+\}\}/);
      const result = issues({
        a: createStep(),
        c: createStep({
          inputs: { title: `{{a.outputs.${segment}}}`, projectId: PROJECT_ID },
          dependsOn: ["a"],
        }),
      });
      expect(codes(result)).toEqual(["UNSAFE_REFERENCE_PATH"]);
    }
  });

  it("rejects a prototype segment on the trigger namespace too", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{trigger.outputs.__proto__}}", projectId: PROJECT_ID },
      }),
    });
    expect(codes(result)).toEqual(["UNSAFE_REFERENCE_PATH"]);
  });
});

describe("malformed and nested references", () => {
  it("reports the nested object path of an invalid reference", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "T",
          projectId: PROJECT_ID,
          payload: { nested: "{{missing.outputs.x}}" },
        },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([
      {
        code: "UNKNOWN_REFERENCE_SOURCE",
        path: "steps.c.inputs.payload.nested",
        message: expect.any(String),
      },
    ]);
  });

  it("reports the array index path of an invalid reference", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "T",
          projectId: PROJECT_ID,
          items: ["literal", "{{a.outputs.nope}}"],
        },
        dependsOn: ["a"],
      }),
    });
    expect(result).toEqual([
      {
        code: "UNKNOWN_OUTPUT",
        path: "steps.c.inputs.items.1",
        message: expect.any(String),
      },
    ]);
  });

  it("flags malformed delimiters nested inside an array", () => {
    const result = issues({
      c: createStep({
        inputs: {
          title: "T",
          projectId: PROJECT_ID,
          items: ["ok", "{{broken"],
        },
      }),
    });
    expect(result).toEqual([
      {
        code: "MALFORMED_REFERENCE",
        path: "steps.c.inputs.items.1",
        message: expect.any(String),
      },
    ]);
  });
});

describe("self-reference and mixed failures", () => {
  it("rejects a self-reference", () => {
    const result = issues({
      c: createStep({
        inputs: { title: "{{c.outputs.taskId}}", projectId: PROJECT_ID },
        dependsOn: ["c"],
      }),
    });
    expect(codes(result)).toEqual(["SELF_REFERENCE"]);
  });

  it("returns multiple issues with stable order and actionable paths", () => {
    const result = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "{{missingStep.outputs.x}}",
          description: "{{a.outputs.nope}}",
          projectId: PROJECT_ID,
        },
        dependsOn: ["a"],
      }),
    });
    expect(result.map((issue) => `${issue.code}@${issue.path}`)).toEqual([
      "UNKNOWN_REFERENCE_SOURCE@steps.c.inputs.title",
      "UNKNOWN_OUTPUT@steps.c.inputs.description",
    ]);

    const again = issues({
      a: createStep(),
      c: createStep({
        inputs: {
          title: "{{missingStep.outputs.x}}",
          description: "{{a.outputs.nope}}",
          projectId: PROJECT_ID,
        },
        dependsOn: ["a"],
      }),
    });
    expect(again).toEqual(result);
  });
});

describe("grammar parity with the runtime resolver", () => {
  const context: Record<string, JsonValue> = {
    a: { outputs: { taskId: "task_1", title: "Alpha" } },
    b: { outputs: { taskId: "task_2", title: "Beta" } },
    trigger: { outputs: { userId: "user_1" } },
  };

  it("recognizes the same tokens the resolver substitutes", () => {
    const sample = "{{a.outputs.taskId}} then {{b.outputs.title}}";
    const { references, malformed } = extractReferences(sample);
    expect(malformed).toBe(false);
    expect(references).toEqual(["a.outputs.taskId", "b.outputs.title"]);

    const resolved = resolveInputs({ v: sample }, context);
    expect(resolved.v).toBe("task_1 then Beta");
  });

  it("resolves every extracted path through the real resolver (whole-string form)", () => {
    for (const reference of ["a.outputs.taskId", "a.outputs.title", "b.outputs.taskId"]) {
      const token = `{{${reference}}}`;
      const extracted = extractReferences(token);
      expect(extracted.references).toEqual([reference]);
      const resolved = resolveInputs({ v: token }, context);
      expect(resolved.v).not.toBe(token);
    }
  });

  it("extracts tokens from interpolated text that the resolver also replaces", () => {
    const sample = "Hello {{a.outputs.title}}, id {{a.outputs.taskId}}!";
    const { references, malformed } = extractReferences(sample);
    expect(malformed).toBe(false);
    expect(references).toEqual(["a.outputs.title", "a.outputs.taskId"]);
    const resolved = resolveInputs({ v: sample }, context);
    expect(String(resolved.v)).not.toContain("{{");
  });

  it("treats a malformed delimiter as literal (resolver) while flagging it (validator)", () => {
    const malformedSample = "{{a.outputs.title";
    expect(extractReferences(malformedSample)).toEqual({
      references: [],
      malformed: true,
    });
    // The resolver's own behaviour: the unmatched delimiter is left intact.
    expect(resolveInputs({ v: malformedSample }, context).v).toBe(malformedSample);
  });
});

describe("resolver integrity", () => {
  it("does not import or reference the validator", () => {
    const source = readSource("src/lib/workflow/execution/resolver.ts");
    expect(source).not.toContain("workflow-proposal-references");
    expect(source).not.toContain("validateProposalReferences");
    expect(source).not.toContain("extractReferences");
  });

  it("still carries the mirrored reference grammar", () => {
    const source = readSource("src/lib/workflow/execution/resolver.ts");
    expect(source).toContain("/\\{\\{([\\w.-]+)\\}\\}/g");
    expect(source).toContain("/^\\{\\{([\\w.-]+)\\}\\}$/");
  });
});
