jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    task: {
      findFirst: jest.fn(),
    },
    comment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { db } from "@/lib/prisma/db";
import { createComment } from "@/app/actions/comments/createComments";
import { deleteComment } from "@/app/actions/comments/deleteComment";
import { Role } from "@prisma/client";

describe("Task Comments & Collaboration Actions (FC-010)", () => {
  const orgSlug = "acme";
  const orgId = "org-1";
  const taskId = "task-100";
  const commentId = "comment-500";
  const authorUserId = "user-author";
  const adminUserId = "user-admin";
  const otherUserId = "user-other";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createComment", () => {
    it("rejects empty or whitespace-only comments", async () => {
      const res = await createComment({
        orgSlug,
        taskId,
        content: "   ",
      });

      expect(res).toBeUndefined();
      expect(db.comment.create).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant comment creation (task not found in caller's org)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: authorUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      // Task belongs to another organization
      (db.task.findFirst as jest.Mock).mockResolvedValue(null);

      // notFound throws in Next.js Server Actions
      await expect(
        createComment({
          orgSlug,
          taskId,
          content: "Hello from another tenant",
        })
      ).rejects.toThrow();

      expect(db.task.findFirst).toHaveBeenCalledWith({
        where: {
          id: taskId,
          project: { orgId },
        },
      });
      expect(db.comment.create).not.toHaveBeenCalled();
    });

    it("successfully creates comment when caller belongs to organization", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: authorUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      (db.task.findFirst as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId: "proj-1",
      });

      (db.comment.create as jest.Mock).mockResolvedValue({
        id: commentId,
        content: "Great progress on the sprint!",
        taskId,
        userId: authorUserId,
        user: {
          id: authorUserId,
          name: "Author User",
          image: null,
        },
      });

      const res = await createComment({
        orgSlug,
        taskId,
        content: "Great progress on the sprint!",
      });

      expect(res).toBeDefined();
      expect(res?.id).toBe(commentId);
      expect(db.comment.create).toHaveBeenCalledWith({
        data: {
          content: "Great progress on the sprint!",
          taskId,
          userId: authorUserId,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              image: true,
            },
          },
        },
      });
    });
  });

  describe("deleteComment", () => {
    it("rejects unauthenticated caller", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue(null);

      const res = await deleteComment({ orgSlug, commentId });
      expect(res.success).toBe(false);
      expect(res.error).toBe("Unauthorized");
      expect(db.comment.delete).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant comment deletion (comment does not belong to caller org)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: adminUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      // Comment belongs to another org
      (db.comment.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await deleteComment({ orgSlug, commentId });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Comment not found in this organization");
      expect(db.comment.findFirst).toHaveBeenCalledWith({
        where: {
          id: commentId,
          task: {
            project: {
              orgId,
            },
          },
        },
        select: expect.any(Object),
      });
      expect(db.comment.delete).not.toHaveBeenCalled();
    });

    it("rejects deletion by non-author MEMBER (Forbidden)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: otherUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      (db.comment.findFirst as jest.Mock).mockResolvedValue({
        id: commentId,
        userId: authorUserId, // Owned by authorUserId, NOT otherUserId
        taskId,
        task: { projectId: "proj-1" },
      });

      const res = await deleteComment({ orgSlug, commentId });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden: Only the comment author or an organization administrator");
      expect(db.comment.delete).not.toHaveBeenCalled();
    });

    it("allows comment author to delete their own comment", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: authorUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      (db.comment.findFirst as jest.Mock).mockResolvedValue({
        id: commentId,
        userId: authorUserId,
        taskId,
        task: { projectId: "proj-1" },
      });

      (db.comment.delete as jest.Mock).mockResolvedValue({ id: commentId });

      const res = await deleteComment({ orgSlug, commentId });
      expect(res.success).toBe(true);
      expect(res.deletedCommentId).toBe(commentId);
      expect(db.comment.delete).toHaveBeenCalledWith({
        where: { id: commentId },
      });
    });

    it("allows organization ADMIN to delete any comment in the organization", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: adminUserId,
        organization: { id: orgId, name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      // Authored by someone else
      (db.comment.findFirst as jest.Mock).mockResolvedValue({
        id: commentId,
        userId: authorUserId,
        taskId,
        task: { projectId: "proj-1" },
      });

      (db.comment.delete as jest.Mock).mockResolvedValue({ id: commentId });

      const res = await deleteComment({ orgSlug, commentId });
      expect(res.success).toBe(true);
      expect(res.deletedCommentId).toBe(commentId);
      expect(db.comment.delete).toHaveBeenCalledWith({
        where: { id: commentId },
      });
    });
  });
});
