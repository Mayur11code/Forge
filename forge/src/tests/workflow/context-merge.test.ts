// src/tests/workflow/context-merge.test.ts
//
// Step output merging: finding A.
//
// Every successful step writes its output into one shared `WorkflowRun.context`
// blob, and parallel branches write it at the same time. The original code was a
// read-modify-write with no concurrency control:
//
//   const run = await db.workflowRun.findUnique(...)
//   await db.workflowRun.update({ data: { context: { ...run.context, [stepId]: ... } } })
//
// Two branches completing together both read the same context, each adds its
// own key, each writes the whole blob back. The second write erases the first.
//
// The reason this is dangerous rather than merely wrong: nothing fails. Both
// steps report SUCCESS, the run advances, the audit log is complete, and the
// only evidence is a downstream step resolving `{{b.outputs.x}}` to undefined
// because branch b's result silently vanished. It reads as a template or
// resolver bug and sends the next person looking in the wrong place.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import { appendStepOutputToContext } from "@/lib/workflow/execution/state";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const RUN_ID = "run_1";

function seedRun(context: Record<string, unknown> = {}, contextVersion = 0) {
  resetStore();
  store.runs.push({
    id: RUN_ID,
    workflowId: "wf_1",
    status: "RUNNING",
    context,
    contextVersion,
    lastAdvancedAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  });
}

function run() {
  return store.runs[0] as {
    context: unknown;
    contextVersion: number;
  };
}

/** Run the real `updateMany`, but let a sibling commit in between. */
function interleaveSiblingWrite(siblingStepId: string, siblingData: unknown) {
  const real = prismaDouble.workflowRun.updateMany.getMockImplementation()!;

  prismaDouble.workflowRun.updateMany.mockImplementation(async (args) => {
    await real(args);
    const row = run();
    row.context = {
      ...(row.context as Record<string, unknown>),
      [siblingStepId]: { outputs: siblingData },
    };
    row.contextVersion += 1;
    return { count: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
});

// ---------------------------------------------------------------------------
// The lost update itself
// ---------------------------------------------------------------------------

describe("appendStepOutputToContext: concurrent merges", () => {
  it("preserves a sibling's output written during the merge", async () => {
    // The regression test for finding A. The first update wins, a sibling writes
    // second, so this merge's compare-and-set is refused, and it must re-read
    // rather than write the stale blob back.
    seedRun();
    interleaveSiblingWrite("b", { fromBranch: "b" });

    await appendStepOutputToContext(RUN_ID, "a", { fromBranch: "a" });

    const context = run().context as Record<string, { outputs: unknown }>;
    expect(context.a.outputs).toEqual({ fromBranch: "a" });
    expect(context.b.outputs).toEqual({ fromBranch: "b" });
  });

  it("keeps a key the sibling added between the read and the write", async () => {
    seedRun();
    interleaveSiblingWrite("b", { value: 2 });

    await appendStepOutputToContext(RUN_ID, "a", { value: 1 });

    expect(Object.keys(run().context as object).sort()).toEqual(["a", "b"]);
  });

  it("serialises two truly simultaneous merges without dropping either", async () => {
    // Both branches call the merge at the same moment. Interleaving the writes
    // forces each to retry against the other's committed version, so this
    // exercises the loop rather than the happy path.
    seedRun();

    const [fromA, fromB] = await Promise.all([
      appendStepOutputToContext(RUN_ID, "a", { value: "a" }),
      appendStepOutputToContext(RUN_ID, "b", { value: "b" }),
    ]);

    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();

    const context = run().context as Record<string, { outputs: { value: string } }>;
    expect(context.a.outputs.value).toBe("a");
    expect(context.b.outputs.value).toBe("b");
  });

  it("increments the version on every committed merge", async () => {
    seedRun();

    await appendStepOutputToContext(RUN_ID, "a", { n: 1 });
    expect(run().contextVersion).toBe(1);

    await appendStepOutputToContext(RUN_ID, "b", { n: 2 });
    expect(run().contextVersion).toBe(2);
  });

  it("does not advance the version for a refused write", async () => {
    // Refuse the first attempt, allow the second. A version bumped by a refused
    // update would be a version nobody wrote, which would let the *next*
    // merge's predicate pass against state that does not describe the blob.
    seedRun();

    const real = prismaDouble.workflowRun.updateMany.getMockImplementation()!;
    let attempts = 0;

    prismaDouble.workflowRun.updateMany.mockImplementation(async (args) => {
      attempts += 1;
      if (attempts === 1) return { count: 0 };
      return real(args);
    });

    await appendStepOutputToContext(RUN_ID, "a", { value: 1 });

    expect(attempts).toBe(2);
    expect(run().contextVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What the context is supposed to look like
// ---------------------------------------------------------------------------

describe("appendStepOutputToContext: shape", () => {
  it("namespaces each step's output under its own key", async () => {
    // Two steps producing `{ id: 1 }` must not collide. A flat merge would let
    // the second overwrite the first and the run would have lost a resource id.
    seedRun();

    await appendStepOutputToContext(RUN_ID, "a", { id: 1 });
    await appendStepOutputToContext(RUN_ID, "b", { id: 1 });

    const context = run().context as Record<string, { outputs: { id: number } }>;
    expect(context.a.outputs.id).toBe(1);
    expect(context.b.outputs.id).toBe(1);
  });

  it("carries the whole context forward, not just the new key", async () => {
    seedRun({ seeded: { outputs: { kept: true } } });

    await appendStepOutputToContext(RUN_ID, "a", { fresh: true });

    const context = run().context as Record<string, { outputs: unknown }>;
    expect(context.seeded.outputs).toEqual({ kept: true });
    expect(context.a.outputs).toEqual({ fresh: true });
  });

  it("replaces a step's own entry on a re-run without disturbing others", async () => {
    // A re-executed step writes new outputs under the same key; the merge
    // overwrites that key only.
    seedRun();
    await appendStepOutputToContext(RUN_ID, "a", { attempt: 1 });
    await appendStepOutputToContext(RUN_ID, "b", { attempt: 1 });
    await appendStepOutputToContext(RUN_ID, "a", { attempt: 2 });

    const context = run().context as Record<string, { outputs: { attempt: number } }>;
    expect(context.a.outputs.attempt).toBe(2);
    expect(context.b.outputs.attempt).toBe(1);
  });

  it("treats a null context as empty", async () => {
    seedRun({} as never);
    run().context = null;

    await appendStepOutputToContext(RUN_ID, "a", { ok: true });

    const context = run().context as Record<string, { outputs: unknown }>;
    expect(context.a.outputs).toEqual({ ok: true });
  });

  it("returns the merged context to its caller", async () => {
    seedRun();

    const merged = await appendStepOutputToContext(RUN_ID, "a", { value: 7 });

    expect(merged).toEqual({ a: { outputs: { value: 7 } } });
  });
});

// ---------------------------------------------------------------------------
// Bounded, and honest when it cannot converge
// ---------------------------------------------------------------------------

describe("appendStepOutputToContext: contention bound", () => {
  it("retries a bounded number of times and then fails loudly", async () => {
    // Giving up quietly is the failure mode worth guarding. If the merge
    // exhausted its attempts and returned anyway, the caller would mark the step
    // SUCCESS with its output missing from the context - the exact silent
    // corruption this function was changed to prevent.
    seedRun();
    prismaDouble.workflowRun.updateMany.mockImplementation(async () => ({ count: 0 }));

    await expect(appendStepOutputToContext(RUN_ID, "a", {})).rejects.toThrow(
      /Concurrent writers are not settling/i,
    );
  });

  it("rejects rather than resolving when the run has disappeared", async () => {
    resetStore();
    prismaDouble.workflowRun.findUnique.mockImplementation(async () => null);

    await expect(appendStepOutputToContext(RUN_ID, "a", {})).rejects.toThrow(
      /CRITICAL: WorkflowRun run_1 not found/i,
    );
  });

  it("surfaces a database failure instead of retrying it into ambiguity", async () => {
    seedRun();
    prismaDouble.workflowRun.findUnique.mockImplementation(async () => {
      throw new Error("connection reset");
    });

    await expect(appendStepOutputToContext(RUN_ID, "a", {})).rejects.toThrow(
      "connection reset",
    );
  });
});
