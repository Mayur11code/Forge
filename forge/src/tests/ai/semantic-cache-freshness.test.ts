// src/tests/ai/semantic-cache-freshness.test.ts
jest.mock('server-only', () => ({}));

// Redis Mock
jest.mock('@/lib/redis/client', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    scan: jest.fn().mockResolvedValue(['0', []]),
    del: jest.fn(),
  },
}));

// Pinecone Mock
const mockNamespaceQuery = jest.fn();
const mockNamespaceUpsert = jest.fn();
const mockNamespaceDeleteAll = jest.fn();
const mockNamespaceDeleteMany = jest.fn().mockResolvedValue(undefined);
const mockRawIndex = {
  namespace: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => mockNamespaceQuery(...args),
    upsert: (...args: unknown[]) => mockNamespaceUpsert(...args),
    deleteAll: (...args: unknown[]) => mockNamespaceDeleteAll(...args),
    deleteMany: (...args: unknown[]) => mockNamespaceDeleteMany(...args),
  }),
};
const mockTenantVectorQuery = jest.fn().mockResolvedValue({ matches: [] });
const mockTenantVectorUpsert = jest.fn().mockResolvedValue(undefined);
const mockTenantVectorDeleteByTask = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/vector/client', () => ({
  getRawPineconeIndex: jest.fn().mockImplementation(() => mockRawIndex),
  getTenantVectorStore: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => mockTenantVectorQuery(...args),
    upsert: (...args: unknown[]) => mockTenantVectorUpsert(...args),
    deleteByTask: (...args: unknown[]) => mockTenantVectorDeleteByTask(...args),
  }),
}));

// Queue publishEvent Mock
jest.mock('@/lib/events/queue', () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: 'msg_freshness_test' }),
}));

// AI SDK Mock
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    embed: jest.fn().mockResolvedValue({ embedding: new Array(1536).fill(0.01) }),
  };
});

// AI Resolver Mock
const mockBatchEmbedContents = jest.fn().mockResolvedValue({
  embeddings: [{ values: new Array(768).fill(0.02) }],
});

jest.mock('@/lib/ai/resolver', () => ({
  resolveOrganizationLanguageModel: jest
    .fn()
    .mockResolvedValue({ modelId: 'gemini-3.6-flash' }),
  resolveOrganizationEmbeddingModel: jest
    .fn()
    .mockResolvedValue({ modelId: 'gemini-embedding-001' }),
  resolveOrganizationGenerativeAiClient: jest.fn().mockResolvedValue({
    client: {
      getGenerativeModel: jest.fn().mockReturnValue({
        batchEmbedContents: (...args: unknown[]) => mockBatchEmbedContents(...args),
      }),
    },
    fallbackClient: null,
  }),
  AiResolverError: class AiResolverError extends Error {
    public code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'AiResolverError';
    }
  },
}));

// Text extractor & chunker mocks
jest.mock('@/lib/vector/text-extractor', () => ({
  buildSemanticPayload: jest.fn().mockReturnValue('Semantic task description content'),
  extractPureText: jest.fn((text: string) => text ?? ''),
}));

jest.mock('@/lib/vector/semantic-chunker', () => ({
  chunkTextSemantically: jest.fn().mockReturnValue(['Semantic chunk 1']),
}));

// Database Mock
jest.mock('@/lib/prisma/db', () => ({
  db: {
    membership: {
      findFirst: jest.fn(),
    },
    task: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    attachment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $extends: jest.fn(),
  },
}));

jest.mock('@/lib/prisma/extended', () => ({
  prisma: {
    membership: {
      findFirst: jest.fn(),
    },
    task: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    attachment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $extends: jest.fn(),
  },
}));

import {
  retrieveRelevantContextWithProvenance,
} from '@/lib/vector/retreiver';
import {
  taskSourceVersion,
  attachmentSourceVersion,
} from '@/lib/vector/provenance';
import {
  checkSemanticCache,
  setSemanticCache,
  __resetSemanticCacheRuntimeForTests,
} from '@/lib/ai/semantic-cache';
import { dispatchEvent } from '@/lib/events/event-bus';
import { embeddingWorkerHandler } from '@/app/api/worker/embedding-worker/ew';
import { publishEvent } from '@/lib/events/queue';
import { db } from '@/lib/prisma/db';
import { prisma } from '@/lib/prisma/extended';
import { redis } from '@/lib/redis/client';

const mockRedis = redis as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  scan: jest.Mock;
  del: jest.Mock;
};

const mockDb = db as unknown as {
  membership: { findFirst: jest.Mock };
  task: { count: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  attachment: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
};

const mockPrisma = prisma as unknown as {
  membership: { findFirst: jest.Mock };
  task: { count: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  attachment: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
};

const mockPublishEvent = publishEvent as jest.Mock;

describe('Section 7: Semantic Cache Freshness & Invalidation Specifications', () => {
  const ORG_ID = 'org_freshness_corp';
  const USER_ID = 'user_freshness_alice';
  const PROJECT_ID = 'proj_freshness_1';

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSemanticCacheRuntimeForTests();

    // Default valid org membership
    mockDb.membership.findFirst.mockResolvedValue({
      id: 'mem_1',
      userId: USER_ID,
      orgId: ORG_ID,
    });
  });

  // =========================================================================
  // 7.A: Task Freshness Lifecycle
  // =========================================================================
  describe('7.A: Task Freshness Lifecycle', () => {
    const TASK_ID = 'task_freshness_100';
    const dateV1 = new Date('2026-10-01T10:00:00.000Z');
    const dateV2 = new Date('2026-10-02T12:00:00.000Z');

    const versionV1 = taskSourceVersion({ updatedAt: dateV1, projectId: PROJECT_ID });
    const versionV2 = taskSourceVersion({ updatedAt: dateV2, projectId: PROJECT_ID });

    it('excludes stale task chunk from retriever context when Pinecone holds V1 but DB is at V2', async () => {
      // DB state is at V2
      mockDb.task.findMany.mockResolvedValue([
        { id: TASK_ID, updatedAt: dateV2, projectId: PROJECT_ID },
      ]);

      // Pinecone returns vector created under V1
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${TASK_ID}#0`,
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Old Task Content Before Update',
              sourceVersion: versionV1, // Stale!
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('status report', ORG_ID);

      // Must be excluded from authoritative context
      expect(result.context).toBe('');
      // Provenance is incomplete because stale chunks were discarded
      expect(result.provenanceComplete).toBe(false);
      expect(result.provenance).toHaveLength(0);
    });

    it('refuses to seed cache when task chunk is stale, and rejects cache hit if DB version advanced', async () => {
      const testEmbedding = new Array(1536).fill(0.1);
      const testContext = {
        orgId: ORG_ID,
        userId: USER_ID,
        modelId: 'gemini-3.6-flash',
        embeddingModelId: 'gemini-embedding-001',
        promptVersion: 'v1',
        historyFingerprint: 'hist_empty',
      };

      // 1. Refusal to cache with provenanceComplete: false
      await setSemanticCache(
        testEmbedding,
        'status report',
        'Answer generated from stale context',
        {
          ...testContext,
          sources: [{ type: 'task', id: TASK_ID, version: versionV1 }],
          provenanceComplete: false,
        }
      );
      expect(mockRedis.set).not.toHaveBeenCalled();

      // 2. Cache hit rejection if entry had V1 but DB is at V2
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          cacheId: 'cache_key_task_v1',
          cacheVersion: 'v3',
          answerType: 'text',
          answer: 'Cached answer from V1',
          queryDigest: 'some_digest',
          provenance: [{ type: 'task', id: TASK_ID, version: versionV1 }],
          createdAt: Date.now(),
          expiresAt: Math.floor(Date.now() / 1000) + 60000,
          userId: USER_ID,
          orgId: ORG_ID,
          modelId: 'gemini-3.6-flash',
          embeddingModelId: 'gemini-embedding-001',
          promptVersion: 'v1',
          historyFingerprint: 'hist_empty',
        })
      );

      mockNamespaceQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'cache_key_task_v1',
            score: 0.98,
            metadata: {
              schemaVersion: 2,
              orgId: ORG_ID,
              userId: USER_ID,
              languageModelId: 'gemini-3.6-flash',
              embeddingModelId: 'gemini-embedding-001',
              historyFingerprint: 'hist_empty',
              expiresAt: Math.floor(Date.now() / 1000) + 60000,
            },
          },
        ],
      });

      // DB is currently at V2
      mockDb.task.findMany.mockResolvedValue([
        { id: TASK_ID, updatedAt: dateV2, projectId: PROJECT_ID },
      ]);

      const hit = await checkSemanticCache(
        testEmbedding,
        testContext,
        [{ type: 'task', id: TASK_ID, version: versionV1 }]
      );

      // Rejects candidate due to source version mismatch against live DB
      expect(hit).toBeNull();
    });

    it('accepts chunk into context and marks provenance complete once Pinecone holds V2', async () => {
      // DB state is at V2
      mockDb.task.findMany.mockResolvedValue([
        { id: TASK_ID, updatedAt: dateV2, projectId: PROJECT_ID },
      ]);

      // Pinecone re-embedded at V2
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${TASK_ID}#0`,
            score: 0.95,
            metadata: {
              type: 'task',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Fresh Task Content After Update',
              sourceVersion: versionV2,
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('status report', ORG_ID);

      expect(result.context).toContain('Fresh Task Content After Update');
      expect(result.provenanceComplete).toBe(true);
      expect(result.provenance).toEqual([
        { type: 'task', id: TASK_ID, version: versionV2 },
      ]);
    });
  });

  // =========================================================================
  // 7.B: Attachment Freshness Lifecycle
  // =========================================================================
  describe('7.B: Attachment Freshness Lifecycle', () => {
    const ATTACHMENT_ID = 'att_contract_200';
    const PARENT_TASK_ID = 'task_parent_200';

    const parentTaskDateV1 = new Date('2026-10-01T10:00:00.000Z');
    const parentTaskDateV2 = new Date('2026-10-02T12:00:00.000Z');
    const attDate = new Date('2026-10-01T10:05:00.000Z');

    const parentVersionV1 = taskSourceVersion({ updatedAt: parentTaskDateV1, projectId: PROJECT_ID });
    const parentVersionV2 = taskSourceVersion({ updatedAt: parentTaskDateV2, projectId: PROJECT_ID });
    const attVersionV1 = attachmentSourceVersion({
      createdAt: attDate,
      size: 4096,
      taskId: PARENT_TASK_ID,
      name: 'contract.pdf',
    });

    it('rejects attachment chunk when parent task was updated (parentTaskVersion stale in vector)', async () => {
      // Parent task in DB has advanced to V2
      mockDb.task.findMany.mockResolvedValue([
        { id: PARENT_TASK_ID, updatedAt: parentTaskDateV2, projectId: PROJECT_ID },
      ]);
      mockDb.attachment.findMany.mockResolvedValue([
        {
          id: ATTACHMENT_ID,
          taskId: PARENT_TASK_ID,
          createdAt: attDate,
          size: 4096,
          name: 'contract.pdf',
          task: { updatedAt: parentTaskDateV2, projectId: PROJECT_ID },
        },
      ]);

      // Pinecone attachment vector still has parentTaskVersion = V1
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${ATTACHMENT_ID}#0`,
            score: 0.94,
            metadata: {
              type: 'document',
              taskId: PARENT_TASK_ID,
              projectId: PROJECT_ID,
              text: 'Attachment contract terms mentioning parent task title',
              sourceVersion: attVersionV1,
              parentTaskVersion: parentVersionV1, // Stale parent!
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('contract terms', ORG_ID);

      // Stale parent task causes attachment exclusion
      expect(result.context).toBe('');
      expect(result.provenanceComplete).toBe(false);
      expect(result.provenance).toHaveLength(0);
    });

    it('rejects attachment chunk when attachment content changed in DB', async () => {
      const attDateV2 = new Date('2026-10-03T09:00:00.000Z');

      // DB has new attachment version
      mockDb.task.findMany.mockResolvedValue([
        { id: PARENT_TASK_ID, updatedAt: parentTaskDateV1, projectId: PROJECT_ID },
      ]);
      mockDb.attachment.findMany.mockResolvedValue([
        {
          id: ATTACHMENT_ID,
          taskId: PARENT_TASK_ID,
          createdAt: attDateV2,
          size: 8192,
          name: 'contract_v2.pdf',
          task: { updatedAt: parentTaskDateV1, projectId: PROJECT_ID },
        },
      ]);

      // Pinecone holds old attVersionV1
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${ATTACHMENT_ID}#0`,
            score: 0.94,
            metadata: {
              type: 'document',
              taskId: PARENT_TASK_ID,
              projectId: PROJECT_ID,
              text: 'Old attachment terms',
              sourceVersion: attVersionV1, // Stale attachment!
              parentTaskVersion: parentVersionV1,
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('contract terms', ORG_ID);

      expect(result.context).toBe('');
      expect(result.provenanceComplete).toBe(false);
    });

    it('accepts attachment chunk when both attachment and parent task versions match DB', async () => {
      const liveAttVersion = attachmentSourceVersion({
        createdAt: attDate,
        size: 4096,
        taskId: PARENT_TASK_ID,
        name: 'contract.pdf',
        task: { updatedAt: parentTaskDateV2 },
      });

      mockDb.task.findMany.mockResolvedValue([
        { id: PARENT_TASK_ID, updatedAt: parentTaskDateV2, projectId: PROJECT_ID },
      ]);
      mockDb.attachment.findMany.mockResolvedValue([
        {
          id: ATTACHMENT_ID,
          taskId: PARENT_TASK_ID,
          createdAt: attDate,
          size: 4096,
          name: 'contract.pdf',
          task: { updatedAt: parentTaskDateV2, projectId: PROJECT_ID },
        },
      ]);

      // Both versions match current DB state
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${ATTACHMENT_ID}#0`,
            score: 0.96,
            metadata: {
              type: 'document',
              taskId: PARENT_TASK_ID,
              projectId: PROJECT_ID,
              text: 'Current contract terms',
              sourceVersion: liveAttVersion,
              parentTaskVersion: parentVersionV2,
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('contract terms', ORG_ID);

      expect(result.context).toContain('Current contract terms');
      expect(result.provenanceComplete).toBe(true);
      expect(result.provenance).toEqual(
        expect.arrayContaining([
          { type: 'attachment', id: ATTACHMENT_ID, version: liveAttVersion },
          { type: 'task', id: PARENT_TASK_ID, version: parentVersionV2 },
        ])
      );
    });
  });

  // =========================================================================
  // 7.C: Legacy and Malformed Metadata Handling
  // =========================================================================
  describe('7.C: Legacy and Malformed Metadata Handling', () => {
    const TASK_ID = 'task_legacy_300';
    const taskDate = new Date('2026-10-01T10:00:00.000Z');
    const validTaskVersion = taskSourceVersion({ updatedAt: taskDate, projectId: PROJECT_ID });

    beforeEach(() => {
      mockDb.task.findMany.mockResolvedValue([
        { id: TASK_ID, updatedAt: taskDate, projectId: PROJECT_ID },
      ]);
    });

    it('excludes chunk with missing sourceVersion and marks provenance incomplete', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${TASK_ID}#0`,
            score: 0.91,
            metadata: {
              type: 'task',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Legacy chunk without version',
              // sourceVersion omitted
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('query', ORG_ID);

      expect(result.context).toBe('');
      expect(result.provenanceComplete).toBe(false);
    });

    it('excludes chunk with empty or non-string sourceVersion', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${TASK_ID}#0`,
            score: 0.91,
            metadata: {
              type: 'task',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Chunk with empty version string',
              sourceVersion: '',
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('query', ORG_ID);

      expect(result.context).toBe('');
      expect(result.provenanceComplete).toBe(false);
    });

    it('excludes document chunk with missing parentTaskVersion', async () => {
      const ATT_ID = 'att_no_parent_ver';
      mockDb.attachment.findMany.mockResolvedValue([
        {
          id: ATT_ID,
          taskId: TASK_ID,
          createdAt: taskDate,
          size: 1024,
          task: { updatedAt: taskDate, projectId: PROJECT_ID },
        },
      ]);

      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${ATT_ID}#0`,
            score: 0.89,
            metadata: {
              type: 'document',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Attachment chunk missing parentTaskVersion',
              sourceVersion: 'attachment:2026-10-01:1024:task_legacy_300',
              // parentTaskVersion omitted
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('query', ORG_ID);

      expect(result.context).toBe('');
      expect(result.provenanceComplete).toBe(false);
    });

    it('filters out legacy chunks from mixed results and prevents caching', async () => {
      const FRESH_TASK_ID = 'task_fresh_good';
      mockDb.task.findMany.mockResolvedValue([
        { id: TASK_ID, updatedAt: taskDate, projectId: PROJECT_ID },
        { id: FRESH_TASK_ID, updatedAt: taskDate, projectId: PROJECT_ID },
      ]);

      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: `${FRESH_TASK_ID}#0`,
            score: 0.95,
            metadata: {
              type: 'task',
              taskId: FRESH_TASK_ID,
              projectId: PROJECT_ID,
              text: 'Fresh valid chunk',
              sourceVersion: validTaskVersion,
            },
          },
          {
            id: `${TASK_ID}#0`,
            score: 0.90,
            metadata: {
              type: 'task',
              taskId: TASK_ID,
              projectId: PROJECT_ID,
              text: 'Unversioned legacy chunk',
              // Missing sourceVersion
            },
          },
        ],
      });

      const result = await retrieveRelevantContextWithProvenance('query', ORG_ID);

      // Fresh chunk is included in context
      expect(result.context).toContain('Fresh valid chunk');
      // Unversioned chunk is NOT included in context
      expect(result.context).not.toContain('Unversioned legacy chunk');
      // But because an unverifiable match was in the retrieved set, provenance is incomplete
      expect(result.provenanceComplete).toBe(false);
    });
  });

  // =========================================================================
  // 7.D: Event Routing & Embedding Worker Cascade
  // =========================================================================
  describe('7.D: Event Routing & Embedding Worker Cascade', () => {
    it('routes TASK_UPDATED to EMBEDDING_REQUESTED and ANALYTICS_EVENT', async () => {
      const payload = {
        taskId: 'task_event_400',
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        subject: 'Updated Task Title',
        body: 'Updated Task Description',
      };

      const result = await dispatchEvent('TASK_UPDATED', payload);

      expect(result.ok).toBe(true);
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'EMBEDDING_REQUESTED',
        {
          orgId: ORG_ID,
          entityId: 'task_event_400',
          type: 'TASK',
        }
      );
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'ANALYTICS_EVENT',
        expect.objectContaining({
          orgId: ORG_ID,
          eventName: 'TASK_UPDATED',
        })
      );
    });

    it('triggers child attachment re-embedding cascade when a task is embedded', async () => {
      const TASK_ID = 'task_with_children_500';
      const taskDate = new Date('2026-10-05T10:00:00.000Z');

      // Mock task lookup in embedding worker
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        id: TASK_ID,
        title: 'Parent Task',
        description: 'Parent Description',
        projectId: PROJECT_ID,
        updatedAt: taskDate,
        project: { orgId: ORG_ID },
      });

      // Mock child attachments lookup
      mockPrisma.attachment.findMany.mockResolvedValueOnce([
        { id: 'att_child_1' },
        { id: 'att_child_2' },
      ]);

      await embeddingWorkerHandler({
        event: {
          id: 'evt_task_embed_cascade',
          type: 'EMBEDDING_REQUESTED',
          data: {
            orgId: ORG_ID,
            entityId: TASK_ID,
            type: 'TASK',
          },
          time: new Date().toISOString(),
        },
      });

      // Verifies task vectors upserted with sourceVersion
      expect(mockTenantVectorUpsert).toHaveBeenCalledWith(
        `${TASK_ID}#0`,
        expect.any(Array),
        expect.objectContaining({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          sourceVersion: expect.stringMatching(/^task:/),
        })
      );

      // Verifies child attachments cascade events dispatched
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'EMBEDDING_REQUESTED',
        {
          orgId: ORG_ID,
          entityId: 'att_child_1',
          type: 'ATTACHMENT',
        }
      );
      expect(mockPublishEvent).toHaveBeenCalledWith(
        'EMBEDDING_REQUESTED',
        {
          orgId: ORG_ID,
          entityId: 'att_child_2',
          type: 'ATTACHMENT',
        }
      );
    });
  });
});
