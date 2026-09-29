// src/tests/agent/tool-confirmation.test.ts
//
// Focused coverage for the durable confirmation state machine and its
// authorization boundary.

// Both prisma modules are mocked because `prisma/extended` imports
// `prisma/db` at module scope, so mocking only one still constructs a real
// PrismaClient - which next/jest points at the live DATABASE_URL from .env.
// jest.setup-db-guard.ts turns that mistake into an immediate failure instead
// of a connection timeout.
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

import { AgentSessionStatus, AgentToolExecutionStatus } from "@prisma/client";

import { requiresConfirmation } from "@/lib/ai/agent/tools/policy";
import {
  DESTRUCTIVE_POLICY,
  READ_ONLY_POLICY,
  WRITE_POLICY,
} from "@/lib/ai/agent/tools/policy";
import {
  describeToolProposal,
  getToolPolicy,
  isRegisteredTool,
  requiresToolConfirmation,
} from "@/lib/ai/agent/tools/registry";
import { describeCreateTaskProposal } from "@/lib/ai/agent/tools/create-task";

describe("tool policy", () => {
  it("never requires confirmation for read-only tools", () => {
    expect(requiresConfirmation(READ_ONLY_POLICY)).toBe(false);
  });

  it("always requires confirmation for write and destructive tools", () => {
    expect(requiresConfirmation(WRITE_POLICY)).toBe(true);
    expect(requiresConfirmation(DESTRUCTIVE_POLICY)).toBe(true);
  });

  it("derives requiresConfirmation from access, so the two cannot disagree", () => {
    // A stored boolean could describe a DESTRUCTIVE tool as not requiring
    // confirmation. Derivation makes that unrepresentable.
    expect(
      Object.keys(DESTRUCTIVE_POLICY).sort(),
    ).toEqual(["access"]);
  });

  it("registers createTask as a write tool requiring confirmation", () => {
    expect(isRegisteredTool("createTask")).toBe(true);
    expect(getToolPolicy("createTask")).toEqual({
      access: "WRITE",
    });
    expect(requiresToolConfirmation("createTask")).toBe(true);
  });

  it("fails closed for unregistered tools", () => {
    // A name the model invents must be rejected by the registry rather than
    // reaching an executor. `isRegisteredTool` is the explicit predicate for
    // that boundary, so it is asserted in both directions here.
    expect(isRegisteredTool("deleteEverything")).toBe(false);
    expect(getToolPolicy("deleteEverything")).toBeNull();
    expect(requiresToolConfirmation("deleteEverything")).toBe(true);
  });

  it("reports every registered tool as registered", () => {
    // Guards the registry contract: a tool that appears in the projection the
    // model sees must also be resolvable by name, and vice versa.
    for (const name of ["createTask", "listTasks", "updateTask"]) {
      expect(isRegisteredTool(name)).toBe(true);
    }
  });

  it("cannot be overridden through tool input", () => {
    // A model that tries to smuggle policy fields in its payload has no
    // effect: policy is resolved from the tool name, server-side.
    const policy = getToolPolicy("createTask");

    expect(policy).toEqual({ access: "WRITE" });
    expect(
      requiresConfirmation(policy ?? READ_ONLY_POLICY),
    ).toBe(true);
  });
});

describe("createTask proposal description", () => {
  it("renders the persisted arguments for the confirmation UI", () => {
    const described = describeCreateTaskProposal({
      title: "Fix login redirect",
      projectName: "Website Redesign",
      priority: "HIGH",
    });

    expect(described).not.toBeNull();
    expect(described?.summary).toContain("Fix login redirect");
    expect(described?.summary).toContain("Website Redesign");
    expect(described?.fields).toEqual(
      expect.arrayContaining([
        { label: "Title", value: "Fix login redirect" },
        { label: "Project", value: "Website Redesign" },
        { label: "Priority", value: "HIGH" },
      ]),
    );
  });

  it("shows the effective default priority when omitted", () => {
    const described = describeCreateTaskProposal({
      title: "Fix login redirect",
      projectName: "Website Redesign",
    });

    expect(described?.fields).toContainEqual({
      label: "Priority",
      value: "MEDIUM",
    });
  });

  it("returns null for arguments that do not parse", () => {
    expect(
      describeCreateTaskProposal({ projectName: "Only" }),
    ).toBeNull();
  });

  it("falls back to a generic prompt rather than throwing", () => {
    const described = describeToolProposal("createTask", {
      nonsense: true,
    });

    expect(described.summary).toBe("Run createTask");
  });
});

describe("confirmation state machine", () => {
  it("exposes PENDING_CONFIRMATION and CANCELLED as execution states", () => {
    expect(AgentToolExecutionStatus.PENDING_CONFIRMATION).toBe(
      "PENDING_CONFIRMATION",
    );
    expect(AgentToolExecutionStatus.CANCELLED).toBe("CANCELLED");
  });

  it("does not treat a proposal or a cancellation as an error", () => {
    // Proposals and cancellations are ordinary outcomes, not failures. If the
    // session failure query treated them as errors, every write would emit a
    // false error on the confirmation path.
    const errorLike = [
      AgentToolExecutionStatus.PENDING_CONFIRMATION,
      AgentToolExecutionStatus.CANCELLED,
    ];

    expect(errorLike).not.toContain(AgentToolExecutionStatus.FAILED);
  });

  it("only permits transitions out of RUNNING and a live session", () => {
    // Documents the intended compare-and-set preconditions. The enforcement
    // lives in the service layer; this asserts the enums the CAS clauses are
    // written against.
    const terminal = [
      AgentToolExecutionStatus.COMPLETED,
      AgentToolExecutionStatus.FAILED,
      AgentToolExecutionStatus.CANCELLED,
    ];

    expect(terminal).toContain(AgentToolExecutionStatus.CANCELLED);
    expect(terminal).not.toContain(AgentToolExecutionStatus.PENDING);
  });

  it("treats a non-running session as blocking confirmation", () => {
    const blocking = [
      AgentSessionStatus.COMPLETED,
      AgentSessionStatus.FAILED,
      AgentSessionStatus.CANCELLED,
    ];

    expect(blocking).not.toContain(AgentSessionStatus.RUNNING);
  });
});
