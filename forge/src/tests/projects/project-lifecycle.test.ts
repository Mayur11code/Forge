jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    project: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("@/lib/deletion/service", () => ({
  deleteProjectTransactionally: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { db } from "@/lib/prisma/db";
import { deleteProjectTransactionally } from "@/lib/deletion/service";
import {
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
} from "@/app/actions/projects/projectActions";
import { Role } from "@prisma/client";

describe("Project Lifecycle Server Actions (FC-008)", () => {
  const orgSlug = "acme-corp";
  const orgId = "org-123";
  const otherOrgId = "org-999";
  const projectId = "proj-1";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateProject", () => {
    it("rejects unauthenticated callers", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue(null);

      const res = await updateProject(orgSlug, {
        projectId,
        name: "New Name",
        description: "New Desc",
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("Unauthorized");
      expect(db.project.update).not.toHaveBeenCalled();
    });

    it("rejects MEMBER role (insufficient permissions)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-1",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      const res = await updateProject(orgSlug, {
        projectId,
        name: "New Name",
        description: "New Desc",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden");
      expect(db.project.update).not.toHaveBeenCalled();
    });

    it("rejects empty project name via Zod validation", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-1",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const res = await updateProject(orgSlug, {
        projectId,
        name: "   ",
        description: "New Desc",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Project name cannot be empty");
      expect(db.project.update).not.toHaveBeenCalled();
    });

    it("rejects updating a project belonging to another organization (cross-tenant)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-1",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      // Project not found in Org A
      (db.project.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await updateProject(orgSlug, {
        projectId,
        name: "Attempted Name Change",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Project not found in this organization");
      expect(db.project.findFirst).toHaveBeenCalledWith({
        where: { id: projectId, orgId },
      });
      expect(db.project.update).not.toHaveBeenCalled();
    });

    it("successfully updates project when caller is ADMIN", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-1",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        orgId,
        name: "Old Name",
      });

      (db.project.update as jest.Mock).mockResolvedValue({
        id: projectId,
        name: "Updated Name",
        description: "Updated Description",
      });

      const res = await updateProject(orgSlug, {
        projectId,
        name: "Updated Name",
        description: "Updated Description",
      });

      expect(res.success).toBe(true);
      expect(res.project?.name).toBe("Updated Name");
      expect(db.project.update).toHaveBeenCalledWith({
        where: { id: projectId },
        data: {
          name: "Updated Name",
          description: "Updated Description",
        },
        select: {
          id: true,
          name: true,
          description: true,
        },
      });
    });

    it("successfully updates project when caller is MANAGER", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-mgr",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MANAGER },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        orgId,
        name: "Old Name",
      });

      (db.project.update as jest.Mock).mockResolvedValue({
        id: projectId,
        name: "Manager Updated Name",
        description: null,
      });

      const res = await updateProject(orgSlug, {
        projectId,
        name: "Manager Updated Name",
      });

      expect(res.success).toBe(true);
      expect(res.project?.name).toBe("Manager Updated Name");
    });
  });

  describe("archiveProject and unarchiveProject", () => {
    it("rejects unauthenticated or unauthorized callers from archiving", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-mem",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      const res = await archiveProject(orgSlug, projectId);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden");
      expect(db.project.update).not.toHaveBeenCalled();
    });

    it("successfully soft-archives project and sets archivedAt timestamp", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        orgId,
        name: "Active Project",
        archivedAt: null,
      });

      (db.project.update as jest.Mock).mockResolvedValue({
        id: projectId,
        archivedAt: new Date(),
      });

      const res = await archiveProject(orgSlug, projectId);
      expect(res.success).toBe(true);
      expect(db.project.update).toHaveBeenCalledWith({
        where: { id: projectId },
        data: { archivedAt: expect.any(Date) },
      });
    });

    it("successfully unarchives project and resets archivedAt to null", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        orgId,
        name: "Archived Project",
        archivedAt: new Date(),
      });

      (db.project.update as jest.Mock).mockResolvedValue({
        id: projectId,
        archivedAt: null,
      });

      const res = await unarchiveProject(orgSlug, projectId);
      expect(res.success).toBe(true);
      expect(db.project.update).toHaveBeenCalledWith({
        where: { id: projectId },
        data: { archivedAt: null },
      });
    });
  });

  describe("deleteProject", () => {
    it("rejects deletion when caller is MEMBER", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-mem",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      const res = await deleteProject(orgSlug, projectId, "Target Project");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden");
      expect(deleteProjectTransactionally).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant deletion (Org A caller cannot delete Org B project)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin-a",
        organization: { id: orgId, name: "Org A" },
        membership: { role: Role.ADMIN },
      });

      // Project belongs to Org B (not found when queried with Org A's ID)
      (db.project.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await deleteProject(orgSlug, projectId, "Org B Project");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Project not found in this organization");
      expect(db.project.findFirst).toHaveBeenCalledWith({
        where: { id: projectId, orgId },
        select: { id: true, name: true },
      });
      expect(deleteProjectTransactionally).not.toHaveBeenCalled();
    });

    it("rejects deletion when confirmed name does not match project name", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        name: "Mission Critical Alpha",
      });

      const res = await deleteProject(orgSlug, projectId, "Wrong Name Typed");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Confirmation mismatch");
      expect(deleteProjectTransactionally).not.toHaveBeenCalled();
    });

    it("executes transactional cascade deletion when confirmed name matches exactly", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      (db.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectId,
        name: "Mission Critical Alpha",
      });

      (deleteProjectTransactionally as jest.Mock).mockResolvedValue({
        success: true,
        projectId,
        orgId,
        deletedTaskIds: ["t-1", "t-2"],
        deletedAttachmentIds: ["att-1"],
      });

      const res = await deleteProject(orgSlug, projectId, "Mission Critical Alpha");
      expect(res.success).toBe(true);
      expect(deleteProjectTransactionally).toHaveBeenCalledWith(projectId);
    });
  });
});
