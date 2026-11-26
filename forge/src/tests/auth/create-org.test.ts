jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    $transaction: jest.fn(),
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { createOrganizationAction } from "@/app/actions/settings/createOrg";
import { Role, TaskStatus, TaskPriority } from "@prisma/client";

describe("createOrganizationAction (FC-003)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    const result = await createOrganizationAction({ name: "Acme Corp" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unauthorized");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects empty or whitespace organization name", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_123", email: "user@example.com" },
    });

    const result = await createOrganizationAction({ name: "   " });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Organization name is required");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("successfully creates organization, ADMIN membership, starter project and task in single transaction", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_founder_456", email: "founder@example.com" },
    });

    const mockTx = {
      organization: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "org_uuid_789",
          slug: "acme-corp",
          name: "Acme Corp",
        }),
      },
      membership: {
        create: jest.fn().mockResolvedValue({
          id: "mem_123",
          userId: "user_founder_456",
          orgId: "org_uuid_789",
          role: Role.ADMIN,
        }),
      },
      project: {
        create: jest.fn().mockResolvedValue({
          id: "proj_123",
          name: "General",
          orgId: "org_uuid_789",
        }),
      },
      task: {
        create: jest.fn().mockResolvedValue({
          id: "task_123",
          title: "Welcome to Forge! Explore your workspace",
        }),
      },
    };

    (db.$transaction as jest.Mock).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await createOrganizationAction({ name: "Acme Corp" });

    expect(result.success).toBe(true);
    expect(result.orgSlug).toBe("acme-corp");
    expect(result.redirectUrl).toBe("/org/acme-corp/dashboard");

    // Verify transaction steps
    expect(mockTx.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "acme-corp" },
      select: { id: true },
    });

    expect(mockTx.organization.create).toHaveBeenCalledWith({
      data: {
        name: "Acme Corp",
        slug: "acme-corp",
        idempotencyKey: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
      },
    });

    expect(mockTx.membership.create).toHaveBeenCalledWith({
      data: {
        userId: "user_founder_456",
        orgId: "org_uuid_789",
        role: Role.ADMIN,
      },
    });

    expect(mockTx.project.create).toHaveBeenCalledWith({
      data: {
        name: "General",
        description: expect.any(String),
        orgId: "org_uuid_789",
      },
    });

    expect(mockTx.task.create).toHaveBeenCalledWith({
      data: {
        title: expect.stringContaining("Welcome to Forge"),
        description: expect.any(String),
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
        projectId: "proj_123",
        assigneeId: "user_founder_456",
      },
    });
  });

  it("supports creating a second organization for the same user", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_founder_456", email: "founder@example.com" },
    });

    const mockTx = {
      organization: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "org_second_id",
          slug: "second-org",
          name: "Second Org",
        }),
      },
      membership: {
        create: jest.fn().mockResolvedValue({}),
      },
      project: {
        create: jest.fn().mockResolvedValue({ id: "proj_2" }),
      },
      task: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    (db.$transaction as jest.Mock).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await createOrganizationAction({
      name: "Second Org",
      idempotencyKey: "idem_second_org_unique",
    });

    expect(result.success).toBe(true);
    expect(result.orgSlug).toBe("second-org");
    expect(mockTx.organization.create).toHaveBeenCalledWith({
      data: {
        name: "Second Org",
        slug: "second-org",
        idempotencyKey: "idem_second_org_unique",
      },
      select: {
        id: true,
        slug: true,
        name: true,
      },
    });
  });

  it("returns existing organization upon duplicate submission with same idempotency key", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_founder_456", email: "founder@example.com" },
    });

    // Simulate idempotency key already committed for this user
    (db.organization.findUnique as jest.Mock).mockResolvedValue({
      id: "org_already_created",
      slug: "acme-corp",
      name: "Acme Corp",
      memberships: [{ role: Role.ADMIN }],
    });

    const result = await createOrganizationAction({
      name: "Acme Corp",
      idempotencyKey: "idem_replay_key_123",
    });

    expect(result.success).toBe(true);
    expect(result.orgId).toBe("org_already_created");
    expect(result.orgSlug).toBe("acme-corp");
    expect(result.redirectUrl).toBe("/org/acme-corp/dashboard");
    // Database transaction is skipped because existing idempotent record was matched
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("resolves slug collisions by appending a unique random suffix", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_founder_456", email: "founder@example.com" },
    });

    const mockTx = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ id: "existing_org_id" }),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: "org_new_id",
          slug: data.slug,
          name: data.name,
        })),
      },
      membership: {
        create: jest.fn().mockResolvedValue({}),
      },
      project: {
        create: jest.fn().mockResolvedValue({ id: "proj_new" }),
      },
      task: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    (db.$transaction as jest.Mock).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await createOrganizationAction({ name: "Acme Corp" });

    expect(result.success).toBe(true);
    expect(result.orgSlug).toMatch(/^acme-corp-[a-z0-9]{4}$/);
    expect(result.redirectUrl).toBe(`/org/${result.orgSlug}/dashboard`);
  });

  it("handles transaction connection acquisition timeout gracefully", async () => {
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user_founder_456", email: "founder@example.com" },
    });

    (db.$transaction as jest.Mock).mockRejectedValue(
      new Error("Unable to start a transaction in the given time.")
    );

    const result = await createOrganizationAction({ name: "Acme Corp" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Database connection timeout");
  });
});
