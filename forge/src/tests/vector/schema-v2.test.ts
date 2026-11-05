// src/tests/vector/schema-v2.test.ts
import {
  buildVectorId,
  parseVectorId,
  VectorMetadataV2Schema,
  PineconeRecordV2Schema,
} from "@/lib/vector/schema";

describe("Vector V2 Phase B: PR-2 Schema & Identifiers (E1 Suite)", () => {
  describe("buildVectorId & parseVectorId", () => {
    it("builds a canonical Vector V2 ID with entityType, entityId, generationId, and chunkIndex", () => {
      const id = buildVectorId("task", "task_abc-123", "gen_def-456", 0);
      expect(id).toBe("task_task_abc-123_gen_def-456#0");
    });

    it("parses valid task vector IDs accurately", () => {
      const parsed = parseVectorId("task_task_abc-123_gen_def-456#2");
      expect(parsed).toEqual({
        entityType: "task",
        entityId: "task_abc-123",
        generationId: "gen_def-456",
        chunkIndex: 2,
      });
    });

    it("parses valid attachment vector IDs accurately", () => {
      const parsed = parseVectorId("attachment_att_999_gen_888#0");
      expect(parsed).toEqual({
        entityType: "attachment",
        entityId: "att_999",
        generationId: "gen_888",
        chunkIndex: 0,
      });
    });

    it("returns null for malformed or legacy V1 vector IDs", () => {
      expect(parseVectorId("task_123#0")).toBeNull();
      expect(parseVectorId("task_123")).toBeNull();
      expect(parseVectorId("unknown_123_gen_456#0")).toBeNull();
      expect(parseVectorId("task_123_gen_456#notanumber")).toBeNull();
      expect(parseVectorId("")).toBeNull();
    });
  });

  describe("VectorMetadataV2Schema", () => {
    const validMetadata = {
      contractVersion: "v2" as const,
      entityType: "task" as const,
      entityId: "task_123",
      generationId: "gen_456",
      sourceRevision: 3,
      chunkIndex: 0,
      chunkCount: 1,
      orgId: "org_789",
      projectId: "proj_000",
      text: "Task description text chunk",
      title: "Task title",
      status: "IN_PROGRESS" as const,
      priority: "HIGH",
    };

    it("validates a complete, compliant VectorMetadataV2 object", () => {
      const parsed = VectorMetadataV2Schema.parse(validMetadata);
      expect(parsed.contractVersion).toBe("v2");
      expect(parsed.chunkIndex).toBe(0);
      expect(parsed.sourceRevision).toBe(3);
    });

    it("rejects non-v2 contractVersion", () => {
      expect(() =>
        VectorMetadataV2Schema.parse({ ...validMetadata, contractVersion: "v1" })
      ).toThrow();
    });

    it("rejects negative chunkIndex or zero chunkCount", () => {
      expect(() =>
        VectorMetadataV2Schema.parse({ ...validMetadata, chunkIndex: -1 })
      ).toThrow();
      expect(() =>
        VectorMetadataV2Schema.parse({ ...validMetadata, chunkCount: 0 })
      ).toThrow();
    });

    it("rejects missing mandatory fields like orgId, projectId, text", () => {
      const { orgId, ...withoutOrg } = validMetadata;
      expect(() => VectorMetadataV2Schema.parse(withoutOrg)).toThrow();

      const { text, ...withoutText } = validMetadata;
      expect(() => VectorMetadataV2Schema.parse(withoutText)).toThrow();
    });
  });

  describe("PineconeRecordV2Schema", () => {
    const dummyVector = new Array(768).fill(0.0123);
    const validRecord = {
      id: "task_task_123_gen_456#0",
      values: dummyVector,
      metadata: {
        contractVersion: "v2" as const,
        entityType: "task" as const,
        entityId: "task_123",
        generationId: "gen_456",
        sourceRevision: 1,
        chunkIndex: 0,
        chunkCount: 1,
        orgId: "org_1",
        projectId: "proj_1",
        text: "Clean text representation",
        title: undefined, // Must be stripped by sanitizer
      },
    };

    it("validates a compliant Pinecone record and strips undefined fields", () => {
      const parsed = PineconeRecordV2Schema.parse(validRecord);
      expect(parsed.id).toBe("task_task_123_gen_456#0");
      expect(parsed.values).toHaveLength(768);
      expect(parsed.metadata.title).toBeUndefined();
      expect("title" in parsed.metadata).toBe(false);
    });

    it("rejects vector values with dimension other than 768", () => {
      expect(() =>
        PineconeRecordV2Schema.parse({
          ...validRecord,
          values: new Array(512).fill(0.1),
        })
      ).toThrow("Embedding must be exactly 768 dimensions");
    });

    it("rejects invalid record ID formats", () => {
      expect(() =>
        PineconeRecordV2Schema.parse({
          ...validRecord,
          id: "task_123#0", // V1 legacy format
        })
      ).toThrow();
    });
  });
});
