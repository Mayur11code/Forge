// src/tests/agent/generate-workflow.live.test.ts
//
// 37.5's carried-from-37.2 verification clause, in full:
//
//   "inspection confirming that a proposal produced by the REAL model path
//    parses via `validateWorkflowProposal` without a compiler fix-up step."
//
// What "real model path" means here, piece by piece: the configured
// `agentModel` singleton (the same object `runAgentLoop` passes to
// `generateText`), the registered `buildAgentSystemPrompt`, the registered
// `generateWorkflow` tool and its input schema, and the registered executor
// `executeGenerateWorkflow`. The only production component left out is the
// session's message persistence, which records the turn but does not shape the
// proposal the model emits.
//
// "Without a compiler fix-up step" is asserted as: the object the model emitted
// is byte-for-byte unchanged after validation, compilation and execution — no
// field added, renamed or defaulted on the way in — and every one of those
// stages succeeds on that unchanged object. No `repairToolCall` is configured,
// so the AI SDK never repairs a malformed tool input either: a non-conforming
// input reaches this suite as an invalid call and fails the assertion below.
//
// What is NOT claimed: no `Workflow` row, no `WorkflowRun`, no proposal
// persistence, no action execution, no QStash/Redis transport, no deployed
// behaviour (37.16). The PrismaClient refusal installed by jest.setup-db-guard
// stays on for this run, so a database write would fail the suite.
//
// Run:
//   npx jest --config jest.live.config.ts src/tests/agent/generate-workflow.live.test.ts

import type { Prisma } from "@prisma/client";
import { generateText } from "ai";

// Importing the registry reaches the createTask tool, which imports the
// Prisma-backed project/task modules at module load. This suite proves a parse
// boundary, not persistence, so the database boundary is replaced with the
// shared in-memory double (the same one the focused 37.5 suite uses) rather
// than opening a real connection. The db guard stays installed.
jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import { agentModel } from "@/lib/ai/agent/model";
import { buildAgentSystemPrompt } from "@/lib/ai/agent/prompts/system-prompt";
import { executeGenerateWorkflow } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { agentTools } from "@/lib/ai/agent/tools/registry";
import { validateWorkflowProposal } from "@/lib/workflow-types/workflow-proposal";
import { compileWorkflowProposal } from "@/lib/workflow-types/workflow-proposal-compiler";

// One model call, possibly repeated if the model answers in prose instead of
// calling the tool. The agent loop treats that as a turn failure and lets the
// session continue, so a prose turn here is retried rather than recorded as a
// parse failure. It is not a fix-up of the proposal itself.
jest.setTimeout(120_000);

// Format-valid fixture id. Nothing executes in this suite, so no project is
// read: the value exists only because `task.create` requires a cuid-shaped
// projectId and the request must supply every required input for the model to
// have no genuine clarification to ask.
const PROJECT_ID = "cmvtest000000000000000001";

const USER_REQUEST = [
  "Draft a workflow for our client onboarding automation.",
  "",
  "It has two steps, in this order:",
  "1. Create a task titled \"Send the onboarding pack\".",
  "2. Create a task titled \"Confirm onboarding is complete\", after step 1.",
  "",
  `Both tasks are in project ${PROJECT_ID}. Use the task.create action.`,
  "Every required field is given, so nothing needs clarifying: draft the",
  "workflow now.",
].join("\n");

describe("37.5 live-model clause — a real model proposal parses without a fix-up", () => {
  it("validates, compiles and executes the model's emitted input unchanged", async () => {
    const system = buildAgentSystemPrompt({ organizationName: "Forge QA" });

    // Same shape production dispatches: the registered tool definition plus the
    // registered executor. `agentTools` alone carries no `execute` (the loop
    // dispatches separately); attaching it here lets one `generateText` turn
    // exercise both the emitted input and the executor that consumes it.
    const tools = {
      generateWorkflow: {
        ...agentTools.generateWorkflow,
        execute: (input: unknown) =>
          executeGenerateWorkflow(input as Prisma.JsonValue),
      },
    };

    let input: unknown;
    let attempts = 0;
    let invalidCall = false;

    for (; attempts < 3; attempts++) {
      const result = await generateText({
        model: agentModel,
        system,
        messages: [{ role: "user", content: USER_REQUEST }],
        tools,
      });

      const call = result.toolCalls.find(
        (candidate) => candidate.toolName === "generateWorkflow",
      );
      if (!call) continue;
      if ((call as { invalid?: boolean }).invalid === true) {
        invalidCall = true;
        break;
      }
      input = call.input;
      break;
    }

    // The model refused the tool outright, or its input did not satisfy the
    // registered input schema (no repair is configured, so nothing was fixed).
    expect(invalidCall).toBe(false);
    expect(input).toBeDefined();

    const asEmitted = JSON.stringify(input);
    const snapshots: string[] = [asEmitted];

    const validation = validateWorkflowProposal(input);
    if (!validation.success) {
      console.log(
        "[37.5 live] validateWorkflowProposal issues:",
        JSON.stringify(validation.issues, null, 2),
      );
    }
    expect(validation.success).toBe(true);
    snapshots.push(JSON.stringify(input));

    const compiled = compileWorkflowProposal(input);
    if (!compiled.success) {
      console.log(
        "[37.5 live] compileWorkflowProposal issues:",
        JSON.stringify(compiled.issues, null, 2),
      );
    }
    expect(compiled.success).toBe(true);
    if (compiled.success) {
      expect(compiled.proposal).toBeDefined();
      expect(compiled.definition).toBeDefined();
    }
    snapshots.push(JSON.stringify(input));

    const output = await executeGenerateWorkflow(input as Prisma.JsonValue);
    expect(output.type).toBe("json");
    const value = (output as { value: unknown }).value as {
      ok?: boolean;
      proposal?: { steps?: Record<string, { action?: string }> };
    };
    expect(value.ok).toBe(true);
    expect(value.proposal).toBeDefined();
    snapshots.push(JSON.stringify(input));

    // No stage mutated, defaulted or repaired the object it was handed.
    expect(new Set(snapshots).size).toBe(1);

    const proposal = value.proposal;
    const stepIds = Object.keys(proposal?.steps ?? {});
    const actions = Object.values(proposal?.steps ?? {}).map(
      (step) => step.action,
    );

    console.log(
      [
        "[37.5 live] model:                 " + agentModel.modelId,
        "[37.5 live] attempts:              " + attempts,
        "[37.5 live] proposal steps:        " + stepIds.join(", "),
        "[37.5 live] proposal actions:      " + actions.join(", "),
        "[37.5 live] validate:              success",
        "[37.5 live] compile:               success (proposal + definition)",
        "[37.5 live] executor:              {ok:true}",
        "[37.5 live] bytes as emitted:      " + asEmitted.length,
        "[37.5 live] bytes after all stages:" + snapshots[3].length,
        "[37.5 live] mutated in transit:    " + (snapshots[3] !== asEmitted),
      ].join("\n"),
    );
  });
});
