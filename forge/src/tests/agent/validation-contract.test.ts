// src/tests/agent/validation-contract.test.ts
//
// The self-healing loop, and the contract that makes it work.
//
// When the model sends arguments a tool's schema refuses, the rejection is an
// OBSERVATION the model acts on, not a string it reads. Three properties of that
// observation are load-bearing, and each one below is a regression guard:
//
//   1. The failing field is NAMED. "Invalid input: expected number, received
//      string" does not say which of the four optional fields was wrong, so the
//      model cannot correct it - it can only guess, and a guess costs a step.
//   2. Every issue is reported, not just the first. A model that got three
//      fields wrong used to be told about one of them per round trip.
//   3. No submitted value is echoed back into the transcript.
//
// The worker-level cases then check the observation survives the round trip:
// persisted under the exact toolCallId, with the continuation written in the
// same transaction, and a duplicate delivery cannot append a second copy.

jest.mock("server-only", () => ({}));

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

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/status", () => ({
  publishAgentStatus: jest.fn(),
}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withToolExecutionLock: jest.fn(
    async (_id: string, fn: () => Promise<void>) => fn(),
  ),
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  failAgentSession: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionForWorker: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  completeToolExecution: jest.fn(),
  failToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
}));

jest.mock("@/lib/ai/agent/tools/registry", () => ({
  getToolExecutor: jest.fn(),
}));

import { z } from "zod";

import { prismaDouble } from "./helpers/prisma-double";
import { buildValidationFailure } from "@/lib/ai/agent/tools/shared-output";
import { executeListTasks } from "@/lib/ai/agent/tools/list-tasks";
import { executeUpdateTask } from "@/lib/ai/agent/tools/update-task";
import { executeCreateTask } from "@/lib/ai/agent/tools/create-task/execute";
import {
  AGENT_PROMPT_VERSION,
  LEGACY_AGENT_PROMPT_VERSION,
  buildAgentSystemPrompt,
} from "@/lib/ai/agent/prompts/system-prompt";
import { createMessage } from "@/lib/ai/agent/services/message-service";
import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import {
  completeToolExecution,
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { getToolExecutor } from "@/lib/ai/agent/tools/registry";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";

const prisma = prismaDouble as unknown as {
  task: { findMany: jest.Mock; update: jest.Mock };
};

const CTX = {
  orgId: "org_1",
  userId: "user_a",
  executionId: "exec_1",
};

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const EXECUTION_ID = "clxexecccccccccccccccc";
const TOOL_CALL_ID = "call_exact_7f3a";

type FailureShape = {
  ok: boolean;
  code?: string;
  error?: string;
  issues?: { path: string; code: string; message: string }[];
};

function jsonValue(output: unknown): FailureShape {
  return (output as { value: FailureShape }).value;
}

const prompt = buildAgentSystemPrompt({ organizationName: "Acme" });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildValidationFailure", () => {
  const schema = z
    .object({
      title: z.string().min(3),
      limit: z.number(),
    })
    .strict();

  it("names the field that failed, not just the expectation", () => {
    // The exact case the previous `issues[0]?.message` produced: true, but
    // useless, because `title` and `limit` are both on the table.
    const result = buildValidationFailure(
      schema.safeParse({ title: "Fix login", limit: "many" }).error!,
      "listTasks",
    );

    expect(result.code).toBe("INVALID_INPUT");
    expect(result.issues).toEqual([
      {
        path: "limit",
        code: "invalid_type",
        message: expect.stringContaining("expected number"),
      },
    ]);
    // The field name is in the human-readable line too, so a model that reads
    // only `error` still learns where to look.
    expect(result.error).toContain("limit:");
    expect(result.error).toContain("listTasks");
  });

  it("reports every issue, not just the first", () => {
    const result = buildValidationFailure(
      schema.safeParse({ limit: "many" }).error!,
      "createTask",
    );

    // `title` is missing AND `limit` is the wrong type. Both are reported, so
    // one retry fixes both.
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "limit",
      "title",
    ]);
  });

  it("reports truncation instead of silently dropping issues", () => {
    const wide = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
      h: z.string(),
      i: z.string(),
      j: z.string(),
    });

    const result = buildValidationFailure(
      wide.safeParse({}).error!,
      "listTasks",
    );

    expect(result.issues).toHaveLength(8);
    // The model is told 2 more exist, so a capped list is never mistaken for a
    // complete one.
    expect(result.error).toContain("2 more problems not listed");
  });

  it("never echoes a submitted value back into the transcript", () => {
    const result = buildValidationFailure(
      z
        .object({ assigneeId: z.string().cuid() })
        .strict()
        .safeParse({ assigneeId: "hunter2", sessionToken: "sk-live-do-not-echo" })
        .error!,
      "listTasks",
    );

    const serialised = JSON.stringify(result);

    expect(result.issues.map((issue) => issue.code)).toContain(
      "unrecognized_keys",
    );
    expect(serialised).toContain("sessionToken");
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("sk-live-do-not-echo");
  });
});

describe("tool executors agree on the failure shape", () => {
  // One shared builder, so one prompt rule can cover every tool. If a tool ever
  // stops naming fields, the prompt becomes a lie for that tool.
  const cases = [
    {
      name: "listTasks",
      run: () => executeListTasks({ limit: "many" }, CTX),
    },
    {
      name: "updateTask",
      run: () =>
        executeUpdateTask({ taskTitle: "Fix login", status: "ARCHIVED" }, CTX),
    },
    {
      name: "createTask",
      run: () =>
        executeCreateTask({ projectName: "Website", priority: "URGENT" }, CTX),
    },
  ];

  it.each(cases)("$name reports the offending field", async ({ run }) => {
    const value = jsonValue(await run());

    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(value.issues?.length).toBeGreaterThan(0);
    expect(value.issues?.every((issue) => issue.path.length > 0)).toBe(true);
    // The same field name reaches the human-readable line, so a model that
    // reads only `error` still knows what to fix.
    expect(value.error).toContain(value.issues![0]!.path);
  });

  it("keeps a whole-object rejection, whose path is the root, actionable", async () => {
    // updateTask's "at least one field to change" rule is a refine on the
    // object itself, so Zod reports it with an empty path. The field name is
    // carried by the message instead, and must survive - an issue the model
    // cannot interpret is a step burned for nothing.
    const value = jsonValue(
      await executeUpdateTask({ taskTitle: "Fix login" }, CTX),
    );

    expect(value.code).toBe("INVALID_INPUT");
    expect(value.issues).toEqual([
      expect.objectContaining({ path: "" }),
    ]);
    expect(value.error).toMatch(/status.*priority.*assigneeId/i);
  });

  it("reaches no database on a schema rejection", async () => {
    for (const { run } of cases) {
      await run();
    }

    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
});

describe("prompt contract matches the failure the tools emit", () => {
  // A drift guard. The prompt tells the model how to recover from
  // INVALID_INPUT; if the tools ever return a differently named code, the
  // recovery rule silently stops applying.
  it("documents the code the executors actually return", () => {
    expect(prompt).toContain("INVALID_INPUT");
  });

  it("tells the model the field list is correctable, not a user-facing error", () => {
    expect(prompt).toContain("issues");
    expect(prompt).toMatch(/not a failure of the user's request/i);
  });

  it("does not let the model resend arguments it knows were rejected", () => {
    expect(prompt).toMatch(/do not resend arguments/i);
  });

  it("runs under a version that reflects the current contract", () => {
    expect(AGENT_PROMPT_VERSION).not.toBe(LEGACY_AGENT_PROMPT_VERSION);
  });
});

describe("tool worker: the validation observation survives the round trip", () => {
  function workerExecution(status = "PENDING") {
    return {
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "listTasks",
      input: { limit: "many" },
      status,
      session: {
        orgId: "org_1",
        userId: "user_a",
        status: "RUNNING",
        currentStep: 2,
      },
    };
  }

  function toolExecutionEvent() {
    return {
      event: { data: { sessionId: SESSION_ID, executionId: EXECUTION_ID, expectedStep: 3 } },
    } as never;
  }

  function mockRejectedInput() {
    (getToolExecutor as jest.Mock).mockReturnValue(async () => ({
      type: "json",
      value: buildValidationFailure(
        z
          .object({ limit: z.number() })
          .safeParse({ limit: "many" }).error!,
        "listTasks",
      ),
    }));
  }

  beforeEach(() => {
    (getToolExecutionForWorker as jest.Mock).mockResolvedValue(workerExecution());
    (markToolExecutionRunning as jest.Mock).mockResolvedValue(true);
    (completeToolExecution as jest.Mock).mockResolvedValue(true);
    mockRejectedInput();
  });

  it("persists the rejection under the exact toolCallId and continues", async () => {
    await handleToolExecution(toolExecutionEvent());

    const [message] = (createMessage as jest.Mock).mock.calls[0]!;

    // The id the model generated is the id the result answers. A rewritten one
    // would make the next turn's transcript unbuildable.
    expect(message.toolCallId).toBe(TOOL_CALL_ID);
    expect(message.message.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: TOOL_CALL_ID,
      toolName: "listTasks",
      output: {
        value: { ok: false, code: "INVALID_INPUT" },
      },
    });

    // The result names the field, so the next model turn has something to fix.
    expect(message.message.content[0].output.value.error).toContain("limit:");

    // Written in the same transaction as the reason to re-drive the loop.
    expect(message.tx).toBeDefined();
    expect(recordAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AGENT_LOOP_REQUESTED",
        payload: expect.objectContaining({ sessionId: SESSION_ID, expectedStep: 3 }),
      }),
    );
  });

  it("cannot append a second transcript record for a duplicate delivery", async () => {
    await handleToolExecution(toolExecutionEvent());

    // The second delivery loses the PENDING -> RUNNING CAS. The result is
    // therefore written at most once, however many times the queue redelivers.
    (markToolExecutionRunning as jest.Mock).mockResolvedValue(false);
    await handleToolExecution(toolExecutionEvent());

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(recordAgentEvent).toHaveBeenCalledTimes(1);
  });
});
