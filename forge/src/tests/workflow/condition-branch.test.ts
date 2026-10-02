// src/tests/workflow/condition-branch.test.ts
//
// The condition node's output contract, and its numeric coercion.
//
// The evaluator decides conditional routing by reading `branch` out of
// StepRun.outputs (see readBranch in execution/evaluator.ts). Two things have to
// hold for that to work, and neither was true when this test was written:
//
//   1. The action has to return its payload under `data`. The wrapper copies
//      ActionResult.data into StepRun.outputs. This action returned `outputs`,
//      which the wrapper does not read, so every condition step persisted an
//      empty object. readBranch then returned undefined, and the evaluator's
//      `requiredBranch && actualBranch !== requiredBranch` was unconditionally
//      true - so every conditional dependant was skipped and the TRUE branch was
//      unreachable. Nothing failed; the branch simply never ran.
//
//   2. Zero has to survive coercion. The original `Number(value) || value`
//      treats 0 as absent, because Number(0) is falsy, so a resolved value of 0
//      fell through to the raw input and compared as "0" against a real 0.
//
// The first is a silent-wrong-answer bug, which is why it is pinned here rather
// than left to the evaluator's own tests: the evaluator was reading the column
// correctly, and no test anywhere covered what the action put in it.
//
// The coercion cases below were checked against the previous implementation and
// confirmed to differ, so they are guarding a behaviour change rather than
// restating the obvious.

import { executeConditionNode } from "@/lib/workflow/actions/logic/conditions";
import type { JsonValue } from "@/lib/workflow-types/type";

async function branchOf(inputs: Record<string, JsonValue>) {
  const result = await executeConditionNode(inputs);
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
  const data = result.data as Record<string, JsonValue>;
  expect(typeof data.branch).toBe("string");
  return data.branch;
}

describe("executeConditionNode output contract", () => {
  it("returns the payload under data, not outputs", async () => {
    const result = await executeConditionNode({
      value1: 1,
      operator: "==",
      value2: 1,
    });

    // The wrapper reads .data. A payload under any other key is discarded.
    expect(result.data).toEqual(
      expect.objectContaining({ branch: "TRUE" }),
    );
    expect(result).not.toHaveProperty("outputs");
  });

  it("reports TRUE and FALSE as the two branch labels", async () => {
    expect(await branchOf({ value1: 150, operator: ">", value2: 100 })).toBe("TRUE");
    expect(await branchOf({ value1: 50, operator: ">", value2: 100 })).toBe("FALSE");
  });
});

describe("executeConditionNode numeric coercion", () => {
  it("compares zero as a number rather than falling through to the raw value", async () => {
    // `Number("0")` is 0, which is falsy, so the old `Number(v) || v` returned
    // the raw "0" string. Comparing that against a numeric 0 gave false, so a
    // step whose parent resolved the string "0" and a step that resolved the
    // number 0 were treated as unequal. Verified to differ from the previous
    // implementation; the numeric 0-vs-0 case below is a regression guard only.
    expect(await branchOf({ value1: "0", operator: "===", value2: 0 })).toBe("TRUE");
    expect(await branchOf({ value1: "0", operator: "==", value2: 0 })).toBe("TRUE");
    expect(await branchOf({ value1: 0, operator: "===", value2: 0 })).toBe("TRUE");
    expect(await branchOf({ value1: 0, operator: ">", value2: -1 })).toBe("TRUE");
  });

  it("still compares numeric strings as numbers", async () => {
    expect(await branchOf({ value1: "150", operator: ">", value2: "100" })).toBe(
      "TRUE",
    );
    expect(await branchOf({ value1: "50", operator: ">", value2: "100" })).toBe(
      "FALSE",
    );
  });

  it("does not coerce a non-numeric string to a number", async () => {
    expect(await branchOf({ value1: "abc", operator: "==", value2: "abc" })).toBe(
      "TRUE",
    );
    expect(await branchOf({ value1: "abc", operator: ">", value2: "100" })).toBe(
      "FALSE",
    );
  });

  it("leaves an empty string as a string", async () => {
    // Number("") is 0, so a naive numeric parse would make "" equal 0.
    expect(await branchOf({ value1: "", operator: "==", value2: 0 })).toBe("FALSE");
  });
});

describe("executeConditionNode operators", () => {
  it("supports the full operator set", async () => {
    expect(await branchOf({ value1: 1, operator: "===", value2: 1 })).toBe("TRUE");
    expect(await branchOf({ value1: 1, operator: "!==", value2: 2 })).toBe("TRUE");
    expect(await branchOf({ value1: 2, operator: ">=", value2: 2 })).toBe("TRUE");
    expect(await branchOf({ value1: 1, operator: "<=", value2: 2 })).toBe("TRUE");
    expect(await branchOf({ value1: 1, operator: "<", value2: 2 })).toBe("TRUE");
    expect(await branchOf({ value1: "hello", operator: "CONTAINS", value2: "ell" })).toBe(
      "TRUE",
    );
  });

  it("rejects an unsupported operator rather than defaulting to FALSE", async () => {
    await expect(
      executeConditionNode({ value1: 1, operator: "APPROX", value2: 1 }),
    ).rejects.toThrow("Unsupported operator");
  });

  it("rejects a non-string operator", async () => {
    await expect(
      executeConditionNode({ value1: 1, operator: 5, value2: 1 }),
    ).rejects.toThrow("operator string");
  });
});