// src/tests/security/workflow-worker-ingress.test.ts
//
// I6 — alternate reachable public execution path coverage.
//
// The workflow worker (`POST /api/workflow`) is the one surface that both
// re-evaluates a run (`advanceWorkflow`) and executes a step's action
// (`wrapStepOperation`). It is not session-authenticated the way the canvas
// action and the test-run route are; instead it is the QStash callback, and its
// authentication is the Upstash request signature.
//
// This test pins the property that matters for I6: the exported `POST` is the
// signature-verifying wrapper, NOT the raw handler. If a future refactor leaks
// `handler` as the exported entry point (or drops the wrapper), an anonymous
// caller could drive execution, and this test fails.
//
// It does NOT perform a live worker call and does NOT weaken signature
// verification: `verifySignatureAppRouter` is replaced with a spy that records
// the handler it was asked to protect.

jest.mock("server-only", () => ({}));

// `jest.mock` factories are hoisted above the module's own initialisers, so the
// spy is stored on a holder created inside the factory and read after import.
jest.mock("@upstash/qstash/nextjs", () => {
  const calls: unknown[][] = [];
  const verify = (h: unknown) => {
    calls.push([h]);
    return h;
  };
  (verify as unknown as { calls: unknown[][] }).calls = calls;
  return { verifySignatureAppRouter: verify };
});

// Everything the module imports at load time; none of it should execute here.
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/workflow/execution/resolver", () => ({ resolveInputs: jest.fn() }));
jest.mock("@/lib/workflow/execution/wrapper", () => ({ wrapStepOperation: jest.fn() }));
jest.mock("@/lib/workflow/execution/evaluator", () => ({ advanceWorkflow: jest.fn() }));

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { POST } from "@/app/api/workflow/route";

const verifySpy = verifySignatureAppRouter as unknown as {
  calls: unknown[][];
};

describe("workflow worker ingress requires QStash signature verification", () => {
  it("exports a signature-verified wrapper rather than the raw handler", () => {
    // The wrapper factory is what guards the endpoint; it must have been invoked.
    expect(verifySpy.calls.length).toBe(1);

    const protectedHandler = verifySpy.calls[0][0];
    expect(typeof protectedHandler).toBe("function");

    // The exported POST is the object returned by the wrapper (here, the handler
    // the spy returned), proving the raw handler is not exported directly.
    expect(POST).toBe(protectedHandler);
  });
});
