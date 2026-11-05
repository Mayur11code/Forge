// src/tests/vector/manifest-digest.test.ts
import { computeManifestDigest, buildVectorId } from "@/lib/vector/schema";

describe("Vector V2 Phase B: PR-2 Manifest Digest Canonical Invariants (E2 Suite)", () => {
  const genId = "gen_test_999";
  const entityId = "task_test_100";

  const chunk0 = {
    chunkIndex: 0,
    id: buildVectorId("task", entityId, genId, 0),
    text: "The first chunk of task text.",
    contentHash: "hash_0000000000000000000000000000000000000000000000000000000000000000",
  };

  const chunk1 = {
    chunkIndex: 1,
    id: buildVectorId("task", entityId, genId, 1),
    text: "The second chunk with further details.",
    contentHash: "hash_1111111111111111111111111111111111111111111111111111111111111111",
  };

  const chunk2 = {
    chunkIndex: 2,
    id: buildVectorId("task", entityId, genId, 2),
    text: "The third chunk concluding the task.",
    contentHash: "hash_2222222222222222222222222222222222222222222222222222222222222222",
  };

  it("produces identical manifest digest regardless of chunk input order", () => {
    const digestAscending = computeManifestDigest([chunk0, chunk1, chunk2]);
    const digestDescending = computeManifestDigest([chunk2, chunk1, chunk0]);
    const digestShuffled = computeManifestDigest([chunk1, chunk2, chunk0]);

    expect(digestAscending).toMatch(/^[0-9a-f]{64}$/);
    expect(digestDescending).toBe(digestAscending);
    expect(digestShuffled).toBe(digestAscending);
  });

  it("computes hash from text when contentHash is omitted", () => {
    const chunkWithoutHash0 = {
      chunkIndex: 0,
      id: buildVectorId("task", entityId, genId, 0),
      text: "The first chunk of task text.",
    };
    const chunkWithoutHash1 = {
      chunkIndex: 1,
      id: buildVectorId("task", entityId, genId, 1),
      text: "The second chunk with further details.",
    };

    const baseDigest = computeManifestDigest([chunkWithoutHash0, chunkWithoutHash1]);
    expect(baseDigest).toMatch(/^[0-9a-f]{64}$/);

    const modifiedChunk = { ...chunkWithoutHash1, text: "Slightly altered text." };
    const modifiedDigest = computeManifestDigest([chunkWithoutHash0, modifiedChunk]);
    expect(modifiedDigest).not.toBe(baseDigest);
  });

  it("changes manifest digest if any chunk contentHash changes", () => {
    const baseDigest = computeManifestDigest([chunk0, chunk1]);
    const modifiedChunk1 = {
      ...chunk1,
      contentHash: "hash_different_11111111111111111111111111111111111111111111111111",
    };
    const modifiedDigest = computeManifestDigest([chunk0, modifiedChunk1]);

    expect(modifiedDigest).not.toBe(baseDigest);
  });

  it("changes manifest digest if a chunk is missing or extra chunk is added", () => {
    const twoChunksDigest = computeManifestDigest([chunk0, chunk1]);
    const threeChunksDigest = computeManifestDigest([chunk0, chunk1, chunk2]);

    expect(threeChunksDigest).not.toBe(twoChunksDigest);
  });

  it("changes manifest digest if chunkIndex is swapped", () => {
    const digestNormal = computeManifestDigest([chunk0, chunk1]);
    const swappedChunk0 = { ...chunk0, chunkIndex: 1 };
    const swappedChunk1 = { ...chunk1, chunkIndex: 0 };
    const digestSwapped = computeManifestDigest([swappedChunk0, swappedChunk1]);

    expect(digestSwapped).not.toBe(digestNormal);
  });
});
