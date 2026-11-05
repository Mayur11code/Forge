// src/tests/vector/pinecone-readback.live.test.ts
/**
 * Forge Vector V2 — Phase B: Pinecone Live Read-Back Verification (E4 Acceptance)
 *
 * Verifies live Pinecone write receipt, bounded read-back polling, and manifest digest validation.
 * Uses an isolated ephemeral namespace.
 */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { buildVectorId, computeManifestDigest, PineconeRecordV2 } from "@/lib/vector/schema";

jest.setTimeout(60_000);

const hasPinecone = Boolean(
  process.env.PINECONE_API_KEY ||
  process.env.PINECONE_API_KEY_DEV ||
  process.env.PINECONE_API_KEY_PROD
);

const describeLive = hasPinecone ? describe : describe.skip;

describeLive("Vector V2 Phase B: Pinecone Live Read-Back Verification (E4)", () => {
  const TEST_ORG_ID = `live_e4_${Date.now().toString(36)}`;
  const TEST_TASK_ID = `task_e4_${Date.now().toString(36)}`;
  const TEST_GEN_ID = `gen_e4_${Date.now().toString(36)}`;
  const SOURCE_REVISION = 1;
  const CHUNK_COUNT = 2;

  const id0 = buildVectorId("task", TEST_TASK_ID, TEST_GEN_ID, 0);
  const id1 = buildVectorId("task", TEST_TASK_ID, TEST_GEN_ID, 1);

  // Generate deterministic 768-dim test vectors
  const vector0 = Array.from({ length: 768 }, (_, i) => Math.sin(i + 1) * 0.1);
  const vector1 = Array.from({ length: 768 }, (_, i) => Math.cos(i + 1) * 0.1);

  const testRecords: PineconeRecordV2[] = [
    {
      id: id0,
      values: vector0,
      metadata: {
        contractVersion: "v2",
        entityType: "task",
        entityId: TEST_TASK_ID,
        generationId: TEST_GEN_ID,
        sourceRevision: SOURCE_REVISION,
        chunkIndex: 0,
        chunkCount: CHUNK_COUNT,
        orgId: TEST_ORG_ID,
        projectId: "proj_live_test",
        text: "First live test chunk content for persistence verification.",
      },
    },
    {
      id: id1,
      values: vector1,
      metadata: {
        contractVersion: "v2",
        entityType: "task",
        entityId: TEST_TASK_ID,
        generationId: TEST_GEN_ID,
        sourceRevision: SOURCE_REVISION,
        chunkIndex: 1,
        chunkCount: CHUNK_COUNT,
        orgId: TEST_ORG_ID,
        projectId: "proj_live_test",
        text: "Second live test chunk content for persistence verification.",
      },
    },
  ];

  const expectedManifestDigest = computeManifestDigest([
    { chunkIndex: 0, id: id0, text: testRecords[0].metadata.text },
    { chunkIndex: 1, id: id1, text: testRecords[1].metadata.text },
  ]);

  let store: ReturnType<typeof getTenantVectorStore>;

  beforeAll(() => {
    store = getTenantVectorStore(TEST_ORG_ID);
  });

  afterAll(async () => {
    if (!store) return;
    try {
      await store.deleteRecord(id0);
      await store.deleteRecord(id1);
    } catch {
      // Best-effort cleanup in test teardown
    }
  });

  it("upserts generation vectors and verifies physical read-back persistence with manifest digest", async () => {
    // 1. Upsert generation vectors to Pinecone
    await store.upsertGenerationVectors(testRecords);

    // 2. Perform bounded read-back polling
    const verification = await verifyPhysicalPersistence({
      orgId: TEST_ORG_ID,
      generationId: TEST_GEN_ID,
      entityType: "task",
      entityId: TEST_TASK_ID,
      sourceRevision: SOURCE_REVISION,
      expectedChunkCount: CHUNK_COUNT,
      expectedManifestDigest,
      maxBudgetMs: 30000,
      initialDelayMs: 500,
    });

    expect(verification.verified).toBe(true);
    if (verification.verified) {
      expect(verification.chunksFound).toBe(CHUNK_COUNT);
      expect(verification.manifestDigest).toBe(expectedManifestDigest);
      expect(verification.readBackLatencyMs).toBeGreaterThan(0);
    }
  });
});
