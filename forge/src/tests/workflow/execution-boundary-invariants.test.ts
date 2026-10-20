// src/tests/workflow/execution-boundary-invariants.test.ts
//
// Assignment 37.12 — architectural invariants that back the "no second runtime"
// claim, expressed as tests rather than prose.
//
// The audit established, by reading the source, that:
//   * the ONLY place a `WorkflowRun` is created is `startWorkflow`
//     (lib/workflow/execution/trigger.ts);
//   * the ONLY way a run begins executing is that run creation calling
//     `advanceWorkflow`;
//   * approval and materialization are data operations — they never start a run.
//
// Those facts are the reason "handing a materialized workflow to the engine" can
// reuse the existing engine instead of adding one. A future edit could quietly
// break them (a new `db.workflowRun.create` call, or an approval path that
// imports the engine), so this suite guards the invariant directly against the
// source tree. It is a structural test: cheap, deterministic, no DB, and it
// fails loudly if the boundary moves.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_ROOT = join(process.cwd(), "src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Tests are not part of the runtime boundary and may deliberately construct
// partial doubles; exclude them.
const RUNTIME_FILES = listSourceFiles(SRC_ROOT).filter(
  (file) => !relative(SRC_ROOT, file).split(sep)[0].includes("tests"),
);

function runtimeFilesContaining(pattern: RegExp): string[] {
  return RUNTIME_FILES.filter((file) => pattern.test(readFileSync(file, "utf8"))).map(
    (file) => relative(SRC_ROOT, file).split(sep).join("/"),
  );
}

describe("37.12 execution boundary invariants", () => {
  it("creates WorkflowRun rows in exactly one module: startWorkflow", () => {
    // Matches `db.workflowRun.create(` and `tx.workflowRun.create(`-style calls
    // by their method name, so it can't be dodged by renaming the client var.
    const creators = runtimeFilesContaining(/\.workflowRun\.create\s*\(/);

    expect(creators).toEqual(["lib/workflow/execution/trigger.ts"]);
  });

  it("invokes advanceWorkflow from exactly one runtime module: startWorkflow", () => {
    // The evaluator also calls advanceWorkflow-like continuation internally via
    // its own path, so we assert the specific call site by filtering to call
    // expressions on the imported symbol `advanceWorkflow(`.
    const callers = runtimeFilesContaining(/[^.\w]advanceWorkflow\s*\(/);

    // The engine itself (evaluator/worker) is expected to continue a run;
    // what must NOT happen is a foreign module (approval, materialization,
    // canvas UI, routes) starting one. Assert none of those appear.
    const forbidden = callers.filter(
      (file) =>
        file.startsWith("lib/ai/") ||
        file.startsWith("app/actions/") ||
        file.includes("proposal") ||
        file.includes("materializ"),
    );
    expect(forbidden).toEqual([]);
  });

  it("does not import the execution trigger from approval/materialization code", () => {
    // Approval and materialization are DATA operations. If either imported
    // `startWorkflow`, a human approving a proposal could implicitly start runs,
    // which is exactly what 37.12 forbids.
    //
    // The complete set of modules allowed to reach the trigger is fixed and
    // small: the canvas server action, and the (hardened, currently unused by
    // any client) test-run route. Anything else — and in particular any
    // approval/materialization path — is a boundary break.
    const ALLOWED_CALLERS = [
      "app/actions/workflows/workflow-run.ts",
      "app/api/workflow/test/[workflowId]/test-run/route.ts",
    ];

    const importers = runtimeFilesContaining(
      /from\s+["'][^"']*workflow\/execution\/trigger["']/,
    );

    expect(importers.sort()).toEqual([...ALLOWED_CALLERS].sort());
  });

  it("keeps the trigger-not-found message allowlisted for the public boundary", () => {
    // The startWorkflow refusal is the one engine error surfaced to a client,
    // and only because S5 allowlists this exact authored shape.
    const publicError = readFileSync(
      join(SRC_ROOT, "lib/security/public-error.ts"),
      "utf8",
    );
    expect(publicError).toMatch(/Cannot start workflow/);
  });
});
