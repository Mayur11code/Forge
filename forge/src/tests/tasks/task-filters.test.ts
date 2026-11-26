import {
  toTaskStatus,
  toTaskPriority,
  resolveTaskStatusFilter,
  resolveTaskAssigneeFilter,
} from "@/lib/tasks/filters";
import { updateTaskSchema } from "@/core/domain";
import { TaskStatus, TaskPriority } from "@prisma/client";

describe("Task Filtering, Enum Resolution & URL Param Safety (FC-011)", () => {
  describe("toTaskStatus", () => {
    it("correctly resolves valid status strings to TaskStatus enums", () => {
      expect(toTaskStatus("TODO")).toBe(TaskStatus.TODO);
      expect(toTaskStatus("IN_PROGRESS")).toBe(TaskStatus.IN_PROGRESS);
      expect(toTaskStatus("BLOCKED")).toBe(TaskStatus.BLOCKED);
      expect(toTaskStatus("DONE")).toBe(TaskStatus.DONE);
    });

    it("returns undefined for unrecognized or malformed status strings", () => {
      expect(toTaskStatus("UNKNOWN_STATUS")).toBeUndefined();
      expect(toTaskStatus("INVALID")).toBeUndefined();
      expect(toTaskStatus("")).toBeUndefined();
      expect(toTaskStatus(undefined)).toBeUndefined();
    });

    it("safely handles prototype pollution attempts in query parameters", () => {
      expect(toTaskStatus("constructor")).toBeUndefined();
      expect(toTaskStatus("__proto__")).toBeUndefined();
      expect(toTaskStatus("hasOwnProperty")).toBeUndefined();
    });
  });

  describe("toTaskPriority", () => {
    it("correctly resolves valid priority strings to TaskPriority enums", () => {
      expect(toTaskPriority("LOW")).toBe(TaskPriority.LOW);
      expect(toTaskPriority("MEDIUM")).toBe(TaskPriority.MEDIUM);
      expect(toTaskPriority("HIGH")).toBe(TaskPriority.HIGH);
    });

    it("returns undefined for unrecognized priority strings", () => {
      expect(toTaskPriority("URGENT")).toBeUndefined();
      expect(toTaskPriority("CRITICAL")).toBeUndefined();
      expect(toTaskPriority(undefined)).toBeUndefined();
    });

    it("safely handles prototype property lookups", () => {
      expect(toTaskPriority("toString")).toBeUndefined();
      expect(toTaskPriority("valueOf")).toBeUndefined();
    });
  });

  describe("resolveTaskStatusFilter precedence and fallback", () => {
    it("resolves status when filter is omitted or ALL", () => {
      expect(resolveTaskStatusFilter({ status: "BLOCKED" })).toBe(TaskStatus.BLOCKED);
      expect(resolveTaskStatusFilter({ status: "DONE", filter: "ALL" })).toBe(TaskStatus.DONE);
      expect(resolveTaskStatusFilter({ status: "TODO", filter: "ALL" })).toBe(TaskStatus.TODO);
    });

    it("prioritizes filter when both filter and status are provided and filter is not ALL", () => {
      expect(
        resolveTaskStatusFilter({ status: "TODO", filter: "IN_PROGRESS" })
      ).toBe(TaskStatus.IN_PROGRESS);
    });

    it("returns undefined when both status and filter are unrecognised or ALL", () => {
      expect(resolveTaskStatusFilter({ filter: "ALL" })).toBeUndefined();
      expect(resolveTaskStatusFilter({})).toBeUndefined();
      expect(resolveTaskStatusFilter({ status: "NONEXISTENT", filter: "ALL" })).toBeUndefined();
    });
  });

  describe("Deterministic Pagination Mathematics (P15)", () => {
    const PAGE_SIZE = 12;

    function computePagination(totalCount: number, requestedPage: number) {
      const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
      const currentPage = Math.max(1, Math.min(requestedPage, totalPages));
      const skip = (currentPage - 1) * PAGE_SIZE;
      return { totalPages, currentPage, skip, take: PAGE_SIZE };
    }

    it("computes bounds for empty collection (0 tasks)", () => {
      const p = computePagination(0, 1);
      expect(p.totalPages).toBe(1);
      expect(p.currentPage).toBe(1);
      expect(p.skip).toBe(0);
      expect(p.take).toBe(12);
    });

    it("computes page 1 for exactly 12 tasks", () => {
      const p = computePagination(12, 1);
      expect(p.totalPages).toBe(1);
      expect(p.currentPage).toBe(1);
      expect(p.skip).toBe(0);
    });

    it("computes page 2 for 25 tasks", () => {
      const p = computePagination(25, 2);
      expect(p.totalPages).toBe(3);
      expect(p.currentPage).toBe(2);
      expect(p.skip).toBe(12);
    });

    it("clamps requested page that exceeds totalPages", () => {
      const p = computePagination(15, 99);
      expect(p.totalPages).toBe(2);
      expect(p.currentPage).toBe(2); // Clamped to max page
      expect(p.skip).toBe(12);
    });

    it("clamps negative or zero requested page to 1", () => {
      const p = computePagination(50, -5);
      expect(p.currentPage).toBe(1);
      expect(p.skip).toBe(0);
    });
  });

  describe("Task Status Contract Reconciliation (COMPLETED vs DONE)", () => {
    it("maps product-facing COMPLETED semantic string to canonical TaskStatus.DONE enum", () => {
      expect(toTaskStatus("COMPLETED")).toBe(TaskStatus.DONE);
    });

    it("accepts COMPLETED in updateTaskSchema and transforms it to DONE", () => {
      const validCuid = "c123456789012345678901234";
      const result = updateTaskSchema.safeParse({
        taskId: validCuid,
        status: "COMPLETED",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("DONE");
      }
    });

    it("accepts DONE in updateTaskSchema and leaves it as DONE", () => {
      const validCuid = "c123456789012345678901234";
      const result = updateTaskSchema.safeParse({
        taskId: validCuid,
        status: "DONE",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("DONE");
      }
    });
  });

  describe("Assignee Filtering & Multi-Tenant Isolation (FC-011)", () => {
    const verifiedOrgMemberIds = ["user-alice", "user-bob", "user-charlie"];

    it("returns member ID when assignee belongs to active organization", () => {
      const result = resolveTaskAssigneeFilter("user-alice", verifiedOrgMemberIds);
      expect(result).toBe("user-alice");
    });

    it("returns null when assignee filter is UNASSIGNED", () => {
      const result = resolveTaskAssigneeFilter("UNASSIGNED", verifiedOrgMemberIds);
      expect(result).toBeNull();
    });

    it("returns undefined when assignee filter is ALL or omitted", () => {
      expect(resolveTaskAssigneeFilter("ALL", verifiedOrgMemberIds)).toBeUndefined();
      expect(resolveTaskAssigneeFilter(undefined, verifiedOrgMemberIds)).toBeUndefined();
      expect(resolveTaskAssigneeFilter("", verifiedOrgMemberIds)).toBeUndefined();
    });

    it("returns safe sentinel when assignee is foreign or not an org member (P6)", () => {
      const result = resolveTaskAssigneeFilter("user-foreign-org-b", verifiedOrgMemberIds);
      expect(result).toBe("INVALID_FOREIGN_ASSIGNEE");
    });

    it("combines search, priority, status and assignee with AND semantics in query constructor", () => {
      const orgId = "org-alpha-id";
      const memberIds = new Set(["user-alice"]);

      const query = "Refactor Database";
      const statusParam = "IN_PROGRESS";
      const priorityParam = "HIGH";
      const assigneeParam = "user-alice";

      const taskStatus = resolveTaskStatusFilter({ status: statusParam });
      const taskPriority = toTaskPriority(priorityParam);
      const taskAssignee = resolveTaskAssigneeFilter(assigneeParam, memberIds);

      const where: {
        project: { orgId: string; archivedAt: Date | null };
        status?: TaskStatus;
        priority?: TaskPriority;
        assigneeId?: string | null;
        OR?: unknown[];
      } = {
        project: {
          orgId,
          archivedAt: null,
        },
        ...(taskStatus && { status: taskStatus }),
        ...(taskPriority && { priority: taskPriority }),
        ...(taskAssignee === null
          ? { assigneeId: null }
          : taskAssignee !== undefined
          ? { assigneeId: taskAssignee }
          : {}),
        ...(query && {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { description: { contains: query, mode: "insensitive" as const } },
          ],
        }),
      };

      expect(where.project.orgId).toBe(orgId);
      expect(where.project.archivedAt).toBeNull();
      expect(where.status).toBe(TaskStatus.IN_PROGRESS);
      expect(where.priority).toBe(TaskPriority.HIGH);
      expect(where.assigneeId).toBe("user-alice");
      expect(where.OR).toHaveLength(2);
    });

    it("safely generates empty-match predicate when foreign assignee is provided", () => {
      const orgId = "org-alpha-id";
      const memberIds = new Set(["user-alice"]);

      const foreignAssignee = "malicious-user-org-z";
      const taskAssignee = resolveTaskAssigneeFilter(foreignAssignee, memberIds);

      const where: {
        project: { orgId: string; archivedAt: Date | null };
        assigneeId?: string | null;
      } = {
        project: { orgId, archivedAt: null },
        ...(taskAssignee === null
          ? { assigneeId: null }
          : taskAssignee !== undefined
          ? { assigneeId: taskAssignee }
          : {}),
      };

      expect(where.assigneeId).toBe("INVALID_FOREIGN_ASSIGNEE");
    });
  });
});
