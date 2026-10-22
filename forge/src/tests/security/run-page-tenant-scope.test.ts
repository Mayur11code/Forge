jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflowRun: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock(
  "@/features/organizations/components/workflow/WorkflowRunDashboard",
  () => ({
    __esModule: true,
    default: jest.fn(() => null),
  }),
);

import { notFound } from "next/navigation";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import WorkflowRunPage from "@/app/org/[orgId]/runs/[runId]/page";

const notFoundMock = notFound as unknown as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;
const runFindFirstMock = db.workflowRun.findFirst as jest.Mock;

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const ORG_A_ID = "org_a_id";
const USER_ID = "user_a";
const SLUG_A = "acme";
const SLUG_B = "globex";
const RUN_ID = "run_a";
const MISSING_RUN_ID = "run_missing";
const FOREIGN_RUN_ID = "run_b";

const access = {
  userId: USER_ID,
  organization: { id: ORG_A_ID },
  membership: { role: "MEMBER" },
};

const run = {
  id: RUN_ID,
  status: "RUNNING",
  workflow: {
    id: "workflow_a",
    name: "Onboard Acme Enterprise",
    uiNodes: [],
    uiEdges: [],
  },
  stepRuns: [],
};

function loadPage(runId: string, orgSlug = SLUG_A) {
  return WorkflowRunPage({
    params: Promise.resolve({ orgId: orgSlug, runId }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  notFoundMock.mockImplementation(() => {
    throw NOT_FOUND;
  });
  getOrgAccessMock.mockResolvedValue(access);
  runFindFirstMock.mockResolvedValue(run);
});

describe("workflow run page tenant scope", () => {
  it("refuses an authenticated user without access to the URL organization before loading a run", async () => {
    getOrgAccessMock.mockResolvedValue(null);

    await expect(loadPage(FOREIGN_RUN_ID, SLUG_B)).rejects.toThrow(NOT_FOUND);

    expect(getOrgAccessMock).toHaveBeenCalledWith(SLUG_B);
    expect(runFindFirstMock).not.toHaveBeenCalled();
  });

  it("loads the run with the authorized organization id, not the URL slug", async () => {
    const result = await loadPage(RUN_ID, SLUG_A);

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(runFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: RUN_ID,
        workflow: {
          organization: {
            id: ORG_A_ID,
          },
        },
      },
      include: {
        workflow: true,
        stepRuns: true,
      },
    });
  });

  it("treats a missing run as not found for an authorized member", async () => {
    runFindFirstMock.mockResolvedValue(null);

    await expect(loadPage(MISSING_RUN_ID, SLUG_A)).rejects.toThrow(NOT_FOUND);

    expect(runFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: MISSING_RUN_ID,
        workflow: {
          organization: {
            id: ORG_A_ID,
          },
        },
      },
      include: {
        workflow: true,
        stepRuns: true,
      },
    });
  });

  it("treats a foreign-tenant run like a missing run for an authorized member", async () => {
    runFindFirstMock.mockResolvedValue(null);

    await expect(loadPage(FOREIGN_RUN_ID, SLUG_A)).rejects.toThrow(NOT_FOUND);

    expect(runFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: FOREIGN_RUN_ID,
        workflow: {
          organization: {
            id: ORG_A_ID,
          },
        },
      },
      include: {
        workflow: true,
        stepRuns: true,
      },
    });
  });
});
