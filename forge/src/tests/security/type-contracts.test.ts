// src/tests/security/type-contracts.test.ts
jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: { $executeRaw: jest.fn(), $queryRaw: jest.fn() } }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import { toPrismaJsonObject, toPrismaJsonValue, renewEventLogLease } from "@/lib/events/worker";
import { toPineconeRecord } from "@/lib/vector/client";
import { recordVectorSyncIntent, completeVectorOutboxEvent } from "@/lib/vector/outbox";
import { filterActiveRagCandidates } from "@/lib/vector/retreiver";
import { PineconeRecordV2, VectorMetadataV2, buildVectorId } from "@/lib/vector/schema";
import { VectorEntityType } from "@prisma/client";

describe("P5 Type Contracts & Boundary Conversions", () => {
  describe("toPrismaJsonObject / toPrismaJsonValue boundary conversion", () => {
    it("converts a valid event payload preserving exact structure and primitives", () => {
      const payload = {
        orgId: "org_123",
        entityId: "task_456",
        sourceRevision: 5,
        isActive: true,
        parentVersion: null,
        metadata: {
          tags: ["alpha", "beta"],
          priority: 1,
        },
      };

      const converted = toPrismaJsonObject(payload);
      expect(converted).toEqual(payload);
    });

    it("strips undefined, function, and symbol properties from objects", () => {
      const payload = {
        orgId: "org_123",
        omitted: undefined,
        fn: () => "evil",
        sym: Symbol("test"),
        valid: "good",
      };

      const converted = toPrismaJsonObject(payload);
      expect(converted).toEqual({
        orgId: "org_123",
        valid: "good",
      });
      expect("omitted" in converted).toBe(false);
      expect("fn" in converted).toBe(false);
      expect("sym" in converted).toBe(false);
    });

    it("rejects non-object root payloads", () => {
      expect(() => toPrismaJsonObject("not an object")).toThrow("Event payload must be a non-null object");
      expect(() => toPrismaJsonObject(null)).toThrow("Event payload must be a non-null object");
      expect(() => toPrismaJsonObject([1, 2, 3])).toThrow("Event payload must be a non-null object");
    });

    it("rejects invalid numbers like NaN and Infinity", () => {
      expect(() => toPrismaJsonValue(NaN)).toThrow("Invalid JSON number: NaN or Infinity");
      expect(() => toPrismaJsonValue(Infinity)).toThrow("Invalid JSON number: NaN or Infinity");
      expect(() => toPrismaJsonValue(-Infinity)).toThrow("Invalid JSON number: NaN or Infinity");
    });

    it("rejects unsupported types like BigInt and functions at value position", () => {
      expect(() => toPrismaJsonValue(BigInt(123))).toThrow("Unsupported JSON value of type bigint");
      expect(() => toPrismaJsonValue(() => {})).toThrow("Unsupported JSON value of type function");
      expect(() => toPrismaJsonValue(Symbol("foo"))).toThrow("Unsupported JSON value of type symbol");
    });
  });

  describe("toPineconeRecord boundary conversion", () => {
    it("preserves exact vector ID, 768-dim values, metadata, and chunk identity", () => {
      const values = new Array(768).fill(0.123);
      const metadata: VectorMetadataV2 = {
        contractVersion: "v2",
        entityType: "task",
        entityId: "task_999",
        generationId: "gen_abc",
        sourceRevision: 4,
        chunkIndex: 2,
        chunkCount: 5,
        orgId: "org_corp",
        projectId: "proj_42",
        text: "Clean chunk of text",
        title: "Database Deadlock Mitigation",
        taskId: "task_999",
        status: "IN_PROGRESS",
        priority: "HIGH",
        manifestDigest: "a".repeat(64),
        parentTaskVersion: "pv_1",
        sourceVersion: "sv_1",
      };

      const v2Record: PineconeRecordV2 = {
        id: buildVectorId("task", "task_999", "gen_abc", 2),
        values,
        metadata,
      };

      const pineconeRecord = toPineconeRecord(v2Record);

      expect(pineconeRecord.id).toBe("task_task_999_gen_abc#2");
      expect(pineconeRecord.values).toHaveLength(768);
      expect(pineconeRecord.metadata).toEqual({
        contractVersion: "v2",
        entityType: "task",
        entityId: "task_999",
        generationId: "gen_abc",
        sourceRevision: 4,
        chunkIndex: 2,
        chunkCount: 5,
        orgId: "org_corp",
        projectId: "proj_42",
        text: "Clean chunk of text",
        title: "Database Deadlock Mitigation",
        taskId: "task_999",
        status: "IN_PROGRESS",
        priority: "HIGH",
        manifestDigest: "a".repeat(64),
        parentTaskVersion: "pv_1",
        sourceVersion: "sv_1",
      });
    });

    it("omits optional undefined metadata fields rather than putting null into Pinecone", () => {
      const values = new Array(768).fill(0.5);
      const metadata: VectorMetadataV2 = {
        contractVersion: "v2",
        entityType: "attachment",
        entityId: "att_111",
        generationId: "gen_xyz",
        sourceRevision: 1,
        chunkIndex: 0,
        chunkCount: 1,
        orgId: "org_corp",
        projectId: "proj_42",
        text: "Attachment content only",
      };

      const v2Record: PineconeRecordV2 = {
        id: buildVectorId("attachment", "att_111", "gen_xyz", 0),
        values,
        metadata,
      };

      const pineconeRecord = toPineconeRecord(v2Record);
      expect(pineconeRecord.metadata?.title).toBeUndefined();
      expect(pineconeRecord.metadata?.taskId).toBeUndefined();
      expect(pineconeRecord.metadata?.status).toBeUndefined();
    });
  });

  describe("Transaction capability contracts (recordVectorSyncIntent / completeVectorOutboxEvent)", () => {
    it("recordVectorSyncIntent succeeds with a client providing $queryRaw capability", async () => {
      const mockTx = {
        $queryRaw: jest.fn()
          .mockResolvedValueOnce([{ id: "head_1", latestRevision: 1 }])
          .mockResolvedValueOnce([{ id: "outbox_1" }]),
      };

      const res = await recordVectorSyncIntent({
        tx: mockTx,
        orgId: "org_test",
        entityType: VectorEntityType.TASK,
        entityId: "task_1",
        contentHash: "hash_123",
      });

      expect(res.headId).toBe("head_1");
      expect(res.sourceRevision).toBe(1);
      expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("completeVectorOutboxEvent succeeds with a client providing $queryRaw capability", async () => {
      const mockDb = {
        $queryRaw: jest.fn().mockResolvedValueOnce([{ id: "outbox_1" }]),
      };

      const completed = await completeVectorOutboxEvent({
        db: mockDb,
        outboxEventId: "outbox_1",
      });

      expect(completed).toBe(true);
      expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe("renewEventLogLease authoritative SQL capability", () => {
    it("successfully renews lease when authoritative $executeRaw executes and updates row", async () => {
      const mockDbClient = {
        $executeRaw: jest.fn().mockResolvedValueOnce(1),
      };

      const res = await renewEventLogLease({
        claimToken: "token_abc",
        extensionSeconds: 60,
        dbClient: mockDbClient,
      });

      expect(res.renewed).toBe(true);
      expect(mockDbClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("fails closed (renewed: false) when authoritative $executeRaw is missing", async () => {
      const res = await renewEventLogLease({
        claimToken: "token_abc",
        extensionSeconds: 60,
        dbClient: {} as unknown as undefined,
      });

      expect(res.renewed).toBe(false);
    });
  });

  describe("Retriever query typing with generated Prisma arguments", () => {
    it("filterActiveRagCandidates works cleanly with accurately typed delegate interfaces", async () => {
      const mockPrisma = {
        vectorEntityHead: {
          findMany: jest.fn().mockResolvedValueOnce([
            {
              entityType: VectorEntityType.TASK,
              entityId: "task_100",
              activeGenId: "gen_active",
              latestRevision: 3,
              isTombstone: false,
            },
          ]),
        },
      };

      const matches = [
        {
          id: buildVectorId("task", "task_100", "gen_active", 0),
          metadata: {
            contractVersion: "v2",
            entityType: "task",
            entityId: "task_100",
            generationId: "gen_active",
            sourceRevision: 3,
            chunkIndex: 0,
            chunkCount: 1,
            orgId: "org_1",
            projectId: "proj_1",
            text: "Valid active candidate",
          },
        },
      ];

      const filtered = await filterActiveRagCandidates(matches, "org_1", {
        prismaClient: mockPrisma,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(matches[0].id);
      expect(mockPrisma.vectorEntityHead.findMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          OR: [{ entityType: VectorEntityType.TASK, entityId: "task_100" }],
        },
        select: {
          entityType: true,
          entityId: true,
          activeGenId: true,
          latestRevision: true,
          isTombstone: true,
        },
      });
    });
  });
});
