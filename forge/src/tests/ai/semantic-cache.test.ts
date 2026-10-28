// src/tests/ai/semantic-cache.test.ts
import {
  checkSemanticCache,
  setSemanticCache,
  invalidateSemanticCacheForOrg,
  __resetSemanticCacheRuntimeForTests,
  type SemanticCacheContext,
} from '@/lib/ai/semantic-cache';
import { simulateCachedStream } from '@/lib/ai/cache-stream';
import {
  retrieveRelevantContext,
  retrieveRelevantContextWithProvenance,
  extractTaskIdsFromContext,
} from '@/lib/vector/retreiver';
import {
  attachmentSourceVersion,
  taskSourceVersion,
  type SourceProvenance,
} from '@/lib/vector/provenance';
import { fingerprintPriorHistory } from '@/lib/ai/cache-identity';
import { POST } from '@/app/api/chat/route';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import { embed, streamText, type ModelMessage } from 'ai';
import { redis } from '@/lib/redis/client';
import { db } from '@/lib/prisma/db';
import {
  AiResolverError,
  resolveOrganizationEmbeddingModel,
  resolveOrganizationLanguageModel,
} from '@/lib/ai/resolver';

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

jest.mock('@/lib/vector/client', () => ({
  getRawPineconeIndex: jest.fn().mockImplementation(() => mockRawIndex),
  getTenantVectorStore: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => mockTenantVectorQuery(...args),
  }),
}));

// Database Mock
jest.mock('@/lib/prisma/db', () => ({
  db: {
    membership: {
      findFirst: jest.fn(),
    },
    task: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    attachment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

// AI SDK Mock
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    embed: jest.fn(),
    streamText: jest.fn(),
  };
});

jest.mock('@/lib/ai/resolver', () => ({
  resolveOrganizationLanguageModel: jest
    .fn()
    .mockResolvedValue({ modelId: 'gemini-3.6-flash' }),
  resolveOrganizationEmbeddingModel: jest
    .fn()
    .mockResolvedValue({ modelId: 'gemini-embedding-001' }),
  AiResolverError: class AiResolverError extends Error {
    public code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'AiResolverError';
    }
  },
}));

jest.mock('@/features/organizations/getOrgAccess', () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock('@/lib/security/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({
    allowed: true,
    headers: {
      'X-RateLimit-Limit': '60',
      'X-RateLimit-Remaining': '59',
    },
  }),
  createRateLimitResponse: jest.fn(),
  RATE_LIMIT_POLICIES: {
    AI_ADMISSION_CHAT: 'AI_ADMISSION_CHAT',
  },
}));

const mockRedis = redis as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  scan: jest.Mock;
  del: jest.Mock;
};
const mockDb = db as unknown as {
  membership: { findFirst: jest.Mock };
  task: { count: jest.Mock; findMany: jest.Mock };
  attachment: { findMany: jest.Mock };
};
const mockEmbed = embed as jest.Mock;
const mockStreamText = streamText as jest.Mock;
const mockGetOrgAccess = getOrgAccess as jest.Mock;
const mockResolveLanguageModel =
  resolveOrganizationLanguageModel as unknown as jest.Mock;
const mockResolveEmbeddingModel =
  resolveOrganizationEmbeddingModel as unknown as jest.Mock;

const DUMMY_EMBEDDING = new Array(768).fill(0.05);
const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const USER_A = 'user_alice';
const USER_B = 'user_bob';

const PROMPT_VERSION = 'v1';
const HISTORY_FINGERPRINT = 'a'.repeat(64);

const CTX: SemanticCacheContext = {
  orgId: ORG_A,
  userId: USER_A,
  modelId: 'gemini-3.6-flash',
  embeddingModelId: 'gemini-embedding-001',
  promptVersion: PROMPT_VERSION,
  historyFingerprint: HISTORY_FINGERPRINT,
};

function taskRow(
  id: string,
  updatedAt = new Date('2026-01-01T00:00:00.000Z'),
  projectId = 'proj_1'
) {
  return { id, updatedAt, projectId };
}

function attachmentRow(
  id: string,
  taskId: string,
  taskUpdatedAt = new Date('2026-01-01T00:00:00.000Z'),
  createdAt = new Date('2026-02-01T00:00:00.000Z'),
  size = 1024
) {
  return { id, taskId, createdAt, size, task: { updatedAt: taskUpdatedAt } };
}

type EntryOverrides = {
  cacheId?: string;
  answer?: string;
  createdAt?: string;
  expiresAt?: string;
  ctx?: Partial<SemanticCacheContext>;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  score?: number;
};

function entryFor(sources: SourceProvenance[], overrides: EntryOverrides = {}) {
  const ctx: SemanticCacheContext = { ...CTX, ...(overrides.ctx ?? {}) };
  const cacheId =
    overrides.cacheId ?? `cache:${ctx.orgId}:${ctx.userId}:${Date.now()}`;
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  const expiresAt =
    overrides.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString();
  const expiresAtUnix = Math.floor(Date.parse(expiresAt) / 1000);
  const answer = overrides.answer ?? 'Cached answer from current sources.';
  const queryDigest = 'a'.repeat(64);

  const shared = {
    cacheVersion: 'v3',
    orgId: ctx.orgId,
    userId: ctx.userId,
    modelId: ctx.modelId,
    embeddingModelId: ctx.embeddingModelId,
    promptVersion: ctx.promptVersion,
    historyFingerprint: ctx.historyFingerprint,
    provenanceComplete: true as const,
    sourceCount: sources.length,
    sourceTypes: sources.map((source) => source.type),
    sourceIds: sources.map((source) => source.id),
    sourceVersions: sources.map((source) => source.version),
    queryDigest,
    createdAt,
    expiresAt,
    expiresAtUnix,
  };

  return {
    cacheId,
    answer,
    match: {
      id: cacheId,
      score: overrides.score ?? 0.95,
      metadata: {
        type: 'cached_query' as const,
        ...shared,
        ...(overrides.metadata ?? {}),
      },
    },
    payload: {
      cacheId,
      answer,
      answerType: 'text' as const,
      ...shared,
      ...(overrides.payload ?? {}),
    },
  };
}

function taskSource(
  id: string,
  updatedAt = new Date('2026-01-01T00:00:00.000Z'),
  projectId = 'proj_1'
): SourceProvenance {
  return {
    type: 'task',
    id,
    version: taskSourceVersion(taskRow(id, updatedAt, projectId)),
  };
}

function attachmentSource(
  id: string,
  taskId: string,
  taskUpdatedAt = new Date('2026-01-01T00:00:00.000Z'),
  createdAt = new Date('2026-02-01T00:00:00.000Z'),
  size = 1024
): SourceProvenance {
  return {
    type: 'attachment',
    id,
    version: attachmentSourceVersion(
      attachmentRow(id, taskId, taskUpdatedAt, createdAt, size)
    ),
  };
}

describe('Forge Semantic Cache — production hardening', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ENABLE_SEMANTIC_CACHE;
    __resetSemanticCacheRuntimeForTests();

    mockRawIndex.namespace.mockReturnValue({
      query: (...args: unknown[]) => mockNamespaceQuery(...args),
      upsert: (...args: unknown[]) => mockNamespaceUpsert(...args),
      deleteAll: (...args: unknown[]) => mockNamespaceDeleteAll(...args),
      deleteMany: (...args: unknown[]) => mockNamespaceDeleteMany(...args),
    });
    mockNamespaceQuery.mockReset();
    mockNamespaceUpsert.mockReset();
    mockNamespaceDeleteAll.mockReset();
    mockNamespaceDeleteMany.mockReset().mockResolvedValue(undefined);

    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.scan.mockReset().mockResolvedValue(['0', []]);
    mockRedis.del.mockReset().mockResolvedValue(1);

    mockDb.membership.findFirst.mockReset().mockResolvedValue({ userId: USER_A });
    mockDb.task.findMany.mockReset().mockResolvedValue([]);
    mockDb.attachment.findMany.mockReset().mockResolvedValue([]);

    mockTenantVectorQuery.mockReset().mockResolvedValue({ matches: [] });

    mockResolveLanguageModel.mockReset().mockResolvedValue({
      modelId: 'gemini-3.6-flash',
    });
    mockResolveEmbeddingModel.mockReset().mockResolvedValue({
      modelId: 'gemini-embedding-001',
    });
    mockEmbed.mockReset();
    mockStreamText.mockReset();
    mockGetOrgAccess.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // 1. Core Lookup & Contract Validation
  // =========================================================================
  describe('checkSemanticCache contract', () => {
    it('returns null on genuine cache miss (no Pinecone matches)', async () => {
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });

      const currentSources = [taskSource('task_1')];
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, currentSources);

      expect(result).toBeNull();
      expect(mockRawIndex.namespace).toHaveBeenCalledWith(`${ORG_A}-cache`);
      expect(mockNamespaceQuery).toHaveBeenCalledWith({
        vector: DUMMY_EMBEDDING,
        topK: 3,
        includeMetadata: true,
        filter: {
          userId: { $eq: USER_A },
          orgId: { $eq: ORG_A },
        },
      });
    });

    it('returns the answer for an authorized, compatible, fresh entry', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBe(entry.answer);
      expect(mockRedis.get).toHaveBeenCalledWith(entry.cacheId);
    });

    it('accepts a payload that Upstash already deserialized to an object', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(entry.payload);

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBe(entry.answer);
    });

    it('rejects candidate below the 0.85 similarity threshold', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], { score: 0.84 });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects expired candidate', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        createdAt: new Date(Date.now() - 20_000).toISOString(),
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockNamespaceDeleteMany).toHaveBeenCalledWith({ ids: [entry.cacheId] });
    });

    it('rejects entries written under another cache contract version', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        metadata: { cacheVersion: 'v2' },
        payload: { cacheVersion: 'v2' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects a legacy record that cannot state its compatibility inputs', async () => {
      mockNamespaceQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'cache:legacy',
            score: 0.99,
            metadata: {
              type: 'cached_query',
              cacheVersion: 'v3',
              orgId: ORG_A,
              userId: USER_A,
              queryDigest: 'a'.repeat(64),
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              expiresAtUnix: Math.floor((Date.now() + 86_400_000) / 1000),
              sourceEntityIds: [],
            },
          },
        ],
      });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects candidate produced by a different language model', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { modelId: 'other-model' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects candidate produced by a different embedding model', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { embeddingModelId: 'other-embedding-model' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects candidate produced by a different prompt version', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { promptVersion: 'v0' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects candidate produced from a different conversation history', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { historyFingerprint: 'b'.repeat(64) },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects candidate when the Redis payload is missing', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(null);

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
      expect(mockNamespaceDeleteMany).toHaveBeenCalledWith({ ids: [entry.cacheId] });
    });

    it('rejects a legacy non-JSON Redis string', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce('Plain legacy string');

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects a payload stored under a different cache id', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        payload: { cacheId: 'cache:someone-else' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects metadata/payload divergence for the same entry', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        payload: { modelId: 'tampered-model' },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('evaluates up to 3 candidates and skips unusable ones', async () => {
      const source = taskSource('task_1');
      const expired = entryFor([source], {
        cacheId: 'cache:org_alpha:user_alice:expired',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      const valid = entryFor([source], {
        cacheId: 'cache:org_alpha:user_alice:valid',
        answer: 'Second candidate is valid.',
      });

      mockNamespaceQuery.mockResolvedValueOnce({
        matches: [expired.match, valid.match],
      });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(valid.payload));

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBe('Second candidate is valid.');
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
      expect(mockRedis.get).toHaveBeenCalledWith(valid.cacheId);
    });

    it('skips a candidate whose payload is missing and serves the next one', async () => {
      const source = taskSource('task_1');
      const broken = entryFor([source], {
        cacheId: 'cache:org_alpha:user_alice:broken',
      });
      const valid = entryFor([source], {
        cacheId: 'cache:org_alpha:user_alice:valid',
        answer: 'Candidate 2 answer is valid.',
      });

      mockNamespaceQuery.mockResolvedValueOnce({
        matches: [broken.match, valid.match],
      });
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(valid.payload));

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBe('Candidate 2 answer is valid.');
      expect(mockRedis.get).toHaveBeenCalledTimes(2);
    });

    it('rejects structurally inconsistent provenance (count vs arrays)', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        metadata: { sourceCount: 2 },
        payload: { sourceCount: 2 },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects a zero-source entry that was somehow written', async () => {
      const entry = entryFor([]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')])
      ).resolves.toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects metadata naming an unknown source kind', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        metadata: { sourceTypes: ['comment'] },
        payload: { sourceTypes: ['comment'] },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });

    it('rejects missing / malformed context before touching the vector store', async () => {
      const source = taskSource('task_1');
      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, {
          ...CTX,
          historyFingerprint: '',
        }, [source])
      ).resolves.toBeNull();
      await expect(
        checkSemanticCache(new Array(767).fill(0), CTX, [source])
      ).resolves.toBeNull();

      expect(mockRawIndex.namespace).not.toHaveBeenCalled();
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
    });

    it('rejects when currentSources is empty or not usable', async () => {
      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [])
      ).resolves.toBeNull();
      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, undefined as unknown as SourceProvenance[])
      ).resolves.toBeNull();
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Authorization & Tenant Isolation
  // =========================================================================
  describe('Authorization and tenant isolation', () => {
    it('rejects immediately when the caller is no longer an organization member', async () => {
      mockDb.membership.findFirst.mockResolvedValueOnce(null);

      const source = taskSource('task_1');
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBeNull();
      expect(mockDb.membership.findFirst).toHaveBeenCalledWith({
        where: { orgId: ORG_A, userId: USER_A },
        select: { userId: true },
      });
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('pins the Pinecone query to the authenticated user and organization', async () => {
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });

      await checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')]);

      expect(mockNamespaceQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            userId: { $eq: USER_A },
            orgId: { $eq: ORG_A },
          },
        })
      );
    });

    it('only addresses the requesting organization namespace', async () => {
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });

      await checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')]);

      expect(mockRawIndex.namespace).toHaveBeenCalledWith(`${ORG_A}-cache`);
      expect(mockRawIndex.namespace).not.toHaveBeenCalledWith(
        `${ORG_B}-cache`
      );
    });

    it('rejects a candidate whose metadata names another user', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { userId: USER_B },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects a candidate whose payload names another user', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        payload: { userId: USER_B },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
    });
  });

  // =========================================================================
  // 3. Provenance & Current Source Set Equality
  // =========================================================================
  describe('Current retrieval source-set validation', () => {
    it('serves cached answer when current retrieval sources match cached provenance', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source]);

      expect(result).toBe(entry.answer);
    });

    it('rejects when a newly relevant task enters the current retrieval set', async () => {
      const source1 = taskSource('task_1');
      const source2 = taskSource('task_2');
      const entry = entryFor([source1]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      // Cached answer only saw task_1; current retrieval found both task_1 and task_2
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source1, source2]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when a newly relevant attachment enters the current retrieval set', async () => {
      const sourceTask = taskSource('task_1');
      const sourceAtt = attachmentSource('att_1', 'task_1');
      const entry = entryFor([sourceTask]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [sourceTask, sourceAtt]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when a previously relevant source leaves the current retrieval set', async () => {
      const source1 = taskSource('task_1');
      const source2 = taskSource('task_2');
      const entry = entryFor([source1, source2]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      // Current retrieval only returns source1
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [source1]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when a referenced task source version changed', async () => {
      const oldSource = taskSource('task_1', new Date('2026-01-01T00:00:00.000Z'));
      const newSource = taskSource('task_1', new Date('2026-03-01T00:00:00.000Z'));
      const entry = entryFor([oldSource]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [newSource]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when the task moved to another project (version changed)', async () => {
      const oldSource = taskSource('task_1', undefined, 'proj_1');
      const newSource = taskSource('task_1', undefined, 'proj_2');
      const entry = entryFor([oldSource]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [newSource]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when attachment parent task changed (parent task version feeds chunk)', async () => {
      const oldTaskDate = new Date('2026-01-01T00:00:00.000Z');
      const newTaskDate = new Date('2026-04-01T00:00:00.000Z');
      const oldAtt = attachmentSource('att_1', 'task_1', oldTaskDate);
      const oldTask = taskSource('task_1', oldTaskDate);
      const entry = entryFor([oldAtt, oldTask]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const newAtt = attachmentSource('att_1', 'task_1', newTaskDate);
      const newTask = taskSource('task_1', newTaskDate);
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [newAtt, newTask]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('rejects when an attachment was replaced with different size/content', async () => {
      const oldAtt = attachmentSource('att_1', 'task_1', undefined, undefined, 1024);
      const newAtt = attachmentSource('att_1', 'task_1', undefined, undefined, 2048);
      const entry = entryFor([oldAtt, taskSource('task_1')]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [newAtt, taskSource('task_1')]);

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('serves an entry whose attachment and parent task are both current', async () => {
      const att = attachmentSource('att_1', 'task_1');
      const task = taskSource('task_1');
      const entry = entryFor([att, task]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, [att, task]);

      expect(result).toBe(entry.answer);
    });
  });

  // =========================================================================
  // 4. Mandatory Regression Tests: Semantic Matching & History Isolation
  // =========================================================================
  describe('Semantic history fingerprinting and similarity matching (Spec §2)', () => {
    it('serves cached answer for a semantically similar but differently worded query (Test A)', async () => {
      // Two requests have identical prior conversation history.
      // Their latest user messages use different wording but have the same intent.
      // The mocked Pinecone candidate has a score above threshold (0.92).
      // Both requests use compatible model, prompt, and embedding configurations.
      // Their current retrieved source sets and versions match.
      // The second request is served from the cache.
      // The normal model-generation function is not called on that valid hit.
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        answer: 'All tasks assigned to Alice.',
        score: 0.92,
      });

      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry.payload));

      const currentSources = [source];
      const result = await checkSemanticCache(DUMMY_EMBEDDING, CTX, currentSources);

      expect(result).toBe('All tasks assigned to Alice.');
      expect(mockRedis.get).toHaveBeenCalledWith(entry.cacheId);
    });

    it('rejects candidate when prior conversation history differs even if query is similar (Test B)', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source], {
        ctx: { historyFingerprint: 'history-a'.padEnd(64, '0') },
      });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });

      const ctxWithDifferentHistory: SemanticCacheContext = {
        ...CTX,
        historyFingerprint: 'history-b'.padEnd(64, '1'),
      };

      const result = await checkSemanticCache(
        DUMMY_EMBEDDING,
        ctxWithDifferentHistory,
        [source]
      );

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('produces a stable, identical fingerprint for single-turn conversations with no prior history', () => {
      const turn1: ModelMessage[] = [
        { role: 'user', content: 'What are my tasks?' },
      ];
      const turn2: ModelMessage[] = [
        { role: 'user', content: 'Show me my tasks for today please' },
      ];

      const fp1 = fingerprintPriorHistory(turn1);
      const fp2 = fingerprintPriorHistory(turn2);

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different fingerprints when earlier turns differ', () => {
      const conversationA: ModelMessage[] = [
        { role: 'user', content: 'Tell me about project Apollo.' },
        { role: 'assistant', content: 'Apollo is active.' },
        { role: 'user', content: 'Who is working on it?' },
      ];
      const conversationB: ModelMessage[] = [
        { role: 'user', content: 'Tell me about project Artemis.' },
        { role: 'assistant', content: 'Artemis is planned.' },
        { role: 'user', content: 'Who is working on it?' },
      ];

      const fpA = fingerprintPriorHistory(conversationA);
      const fpB = fingerprintPriorHistory(conversationB);

      expect(fpA).not.toBe(fpB);
    });
  });

  // =========================================================================
  // 5. Write Path
  // =========================================================================
  describe('setSemanticCache', () => {
    it('writes a v3 entry with verified provenance, query digest, and 7-day TTL', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([
        taskRow('task_1'),
        taskRow('task_2', new Date('2026-01-05T00:00:00.000Z')),
      ]);

      await setSemanticCache(
        DUMMY_EMBEDDING,
        'Original query text',
        'Generated text answer',
        {
          ...CTX,
          provenanceComplete: true,
          sources: [
            taskSource('task_1'),
            taskSource('task_2', new Date('2026-01-05T00:00:00.000Z')),
          ],
        }
      );

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, payloadStr, options] = mockRedis.set.mock.calls[0];
      expect(key).toMatch(new RegExp(`^cache:${ORG_A}:${USER_A}:`));
      expect(options).toEqual({ ex: 60 * 60 * 24 * 7 });

      const payload = JSON.parse(payloadStr as string);
      expect(payload.cacheId).toBe(key);
      expect(payload.answerType).toBe('text');
      expect(payload.cacheVersion).toBe('v3');
      expect(payload.answer).toBe('Generated text answer');
      expect(payload.modelId).toBe(CTX.modelId);
      expect(payload.embeddingModelId).toBe(CTX.embeddingModelId);
      expect(payload.promptVersion).toBe(CTX.promptVersion);
      expect(payload.historyFingerprint).toBe(CTX.historyFingerprint);
      expect(payload.queryDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.originalQuery).toBeUndefined();
      expect(payload.sourceCount).toBe(2);
      expect(payload.sourceTypes).toEqual(['task', 'task']);
      expect(payload.sourceIds).toEqual(['task_1', 'task_2']);
      expect(payload.sourceVersions).toEqual([
        taskSource('task_1').version,
        taskSource('task_2', new Date('2026-01-05T00:00:00.000Z')).version,
      ]);

      expect(mockNamespaceUpsert).toHaveBeenCalledTimes(1);
      const record = mockNamespaceUpsert.mock.calls[0][0].records[0];
      expect(record.id).toBe(key);
      expect(record.values).toEqual(DUMMY_EMBEDDING);
      expect(record.metadata.cacheId).toBeUndefined();
      expect(record.metadata.type).toBe('cached_query');
      expect(record.metadata.cacheVersion).toBe('v3');
      expect(record.metadata.queryDigest).toBe(payload.queryDigest);
      expect(record.metadata.originalQuery).toBeUndefined();
      expect(record.metadata.sourceIds).toEqual(['task_1', 'task_2']);
      expect(record.metadata.sourceVersions).toEqual(payload.sourceVersions);
    });

    it('refuses to cache an answer whose provenance is incomplete', async () => {
      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: false,
        sources: [taskSource('task_1')],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockNamespaceUpsert).not.toHaveBeenCalled();
      expect(mockDb.task.findMany).not.toHaveBeenCalled();
    });

    it('refuses to cache an answer with no sources (negative-result guard)', async () => {
      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockNamespaceUpsert).not.toHaveBeenCalled();
    });

    it('refuses to cache when a source disappeared between retrieval and write', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([]);

      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [taskSource('task_1')],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('refuses to cache when a source changed between retrieval and write', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([
        taskRow('task_1', new Date('2026-05-01T00:00:00.000Z')),
      ]);

      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [taskSource('task_1')],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('never trusts caller-supplied provenance versions', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([taskRow('task_1')]);

      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [{ type: 'task', id: 'task_1', version: 'forged' }],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('rejects inputs that cannot form a verifiable entry', async () => {
      await setSemanticCache(new Array(10).fill(0), 'Query', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [taskSource('task_1')],
      });
      await setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
        ...CTX,
        modelId: '',
        provenanceComplete: true,
        sources: [taskSource('task_1')],
      });
      await setSemanticCache(DUMMY_EMBEDDING, '   ', 'Answer', {
        ...CTX,
        provenanceComplete: true,
        sources: [taskSource('task_1')],
      });

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('swallows storage failures without throwing', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([taskRow('task_1')]);
      mockRedis.set.mockRejectedValueOnce(new Error('Redis connection refused'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        setSemanticCache(DUMMY_EMBEDDING, 'Query', 'Answer', {
          ...CTX,
          provenanceComplete: true,
          sources: [taskSource('task_1')],
        })
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not log query text, answers, or identifiers on failure', async () => {
      mockDb.task.findMany.mockResolvedValueOnce([taskRow('task_1')]);
      mockRedis.set.mockRejectedValueOnce(new Error('Redis connection refused'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await setSemanticCache(
        DUMMY_EMBEDDING,
        'secret query text',
        'secret answer text',
        {
          ...CTX,
          provenanceComplete: true,
          sources: [taskSource('task_1')],
        }
      );

      const logged = warnSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('secret query text');
      expect(logged).not.toContain('secret answer text');
      expect(logged).not.toContain(ORG_A);
      expect(logged).not.toContain(USER_A);
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // 6. Invalidation
  // =========================================================================
  describe('invalidateSemanticCacheForOrg', () => {
    it('clears the org cache namespace and only that org’s Redis keys', async () => {
      mockRedis.scan
        .mockResolvedValueOnce([
          '7',
          [
            `cache:${ORG_A}:${USER_A}:1`,
            `cache:${ORG_A}:${USER_B}:2`,
          ],
        ])
        .mockResolvedValueOnce(['0', [`cache:${ORG_A}:${USER_A}:3`]]);

      const result = await invalidateSemanticCacheForOrg(ORG_A);

      expect(result.pineconeCleared).toBe(true);
      expect(result.redisKeysDeleted).toBe(3);
      expect(result.redisComplete).toBe(true);

      expect(mockRawIndex.namespace).toHaveBeenCalledWith(`${ORG_A}-cache`);
      expect(mockNamespaceDeleteAll).toHaveBeenCalledTimes(1);
      expect(mockRedis.scan).toHaveBeenNthCalledWith(1, 0, {
        match: `cache:${ORG_A}:*`,
        count: 100,
      });
      expect(mockRedis.scan).toHaveBeenNthCalledWith(2, '7', {
        match: `cache:${ORG_A}:*`,
        count: 100,
      });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenNthCalledWith(
        1,
        `cache:${ORG_A}:${USER_A}:1`,
        `cache:${ORG_A}:${USER_B}:2`
      );
      expect(mockRedis.del).toHaveBeenNthCalledWith(
        2,
        `cache:${ORG_A}:${USER_A}:3`
      );
      expect(mockRedis.scan).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ match: `cache:${ORG_B}:*` })
      );
    });

    it('stops after the first full scan when no keys remain', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      const result = await invalidateSemanticCacheForOrg(ORG_A);

      expect(result.pineconeCleared).toBe(true);
      expect(result.redisKeysDeleted).toBe(0);
      expect(result.redisComplete).toBe(true);
      expect(mockRedis.scan).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('is bounded even if the cursor never converges', async () => {
      mockRedis.scan.mockResolvedValue(['7', [`cache:${ORG_A}:${USER_A}:1`]]);

      const result = await invalidateSemanticCacheForOrg(ORG_A);

      expect(result.pineconeCleared).toBe(true);
      expect(result.redisKeysDeleted).toBe(50);
      expect(result.redisComplete).toBe(false); // Reports partial honestly
      expect(mockRedis.scan).toHaveBeenCalledTimes(50);
      expect(mockRedis.del).toHaveBeenCalledTimes(50);
    });

    it('swallows Pinecone and Redis failures during invalidation', async () => {
      mockNamespaceDeleteAll.mockRejectedValueOnce(new Error('pinecone down'));
      mockRedis.scan.mockRejectedValueOnce(new Error('redis down'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await invalidateSemanticCacheForOrg(ORG_A);

      expect(result.pineconeCleared).toBe(false);
      expect(result.redisComplete).toBe(false);
      expect(result.redisKeysDeleted).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('is a no-op for an empty organization id', async () => {
      const result = await invalidateSemanticCacheForOrg('');

      expect(result.pineconeCleared).toBe(false);
      expect(result.redisComplete).toBe(false);
      expect(mockRawIndex.namespace).not.toHaveBeenCalled();
      expect(mockRedis.scan).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. Fail-Open Resilience
  // =========================================================================
  describe('Fail-open resilience', () => {
    it('fails open when the Pinecone query throws', async () => {
      mockNamespaceQuery.mockRejectedValueOnce(new Error('Pinecone timeout'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')])
      ).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('fails open when the membership lookup throws', async () => {
      mockDb.membership.findFirst.mockRejectedValueOnce(new Error('db down'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [taskSource('task_1')])
      ).resolves.toBeNull();
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('fails open when the Redis read throws', async () => {
      const source = taskSource('task_1');
      const entry = entryFor([source]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [entry.match] });
      mockRedis.get.mockRejectedValueOnce(new Error('Redis quota exceeded'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        checkSemanticCache(DUMMY_EMBEDDING, CTX, [source])
      ).resolves.toBeNull();
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // 8. Cached Stream Protocol
  // =========================================================================
  describe('simulateCachedStream', () => {
    it('returns a stream with X-Cache-Hit and merged rate-limit headers', async () => {
      const response = simulateCachedStream('Fast cached answer text', {
        headers: {
          'X-RateLimit-Remaining': '42',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Hit')).toBe('HIT');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('42');
    });

    it('does not artificially delay streaming chunks', async () => {
      const startTime = Date.now();
      const response = simulateCachedStream('A'.repeat(500));
      const text = await response.text();
      const durationMs = Date.now() - startTime;

      expect(text).toContain('A'.repeat(500));
      expect(durationMs).toBeLessThan(500);
    });
  });

  // =========================================================================
  // 9. Retrieval & Provenance Capture
  // =========================================================================
  describe('Retrieval provenance capture', () => {
    it('reuses a precomputed embedding instead of calling embed()', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({ matches: [] });

      await retrieveRelevantContext('What is task 1?', ORG_A, DUMMY_EMBEDDING);

      expect(mockEmbed).not.toHaveBeenCalled();
      expect(mockTenantVectorQuery).toHaveBeenCalledWith(DUMMY_EMBEDDING, 5);
    });

    it('calls embed() when no precomputed embedding is supplied', async () => {
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });

      await retrieveRelevantContext('What is task 1?', ORG_A);

      expect(mockEmbed).toHaveBeenCalledTimes(1);
    });

    it('captures task and attachment provenance, including the parent task', async () => {
      const taskR = taskRow('task_1');
      const attR = attachmentRow('att_1', 'task_1');
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.9,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Task body',
              sourceVersion: taskSourceVersion(taskR),
            },
          },
          {
            id: 'att_1#0',
            score: 0.8,
            metadata: {
              type: 'document',
              taskId: 'task_1',
              text: 'Attachment body',
              sourceVersion: attachmentSourceVersion(attR),
              parentTaskVersion: taskSourceVersion(taskR),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskR]);
      mockDb.attachment.findMany.mockResolvedValue([attR]);

      const result = await retrieveRelevantContextWithProvenance(
        'What is task 1?',
        ORG_A,
        DUMMY_EMBEDDING
      );

      expect(result.context).toContain('Task body');
      expect(result.context).toContain('Attachment body');
      expect(result.provenanceComplete).toBe(true);
      expect(result.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'task', id: 'task_1' }),
          expect.objectContaining({ type: 'attachment', id: 'att_1' }),
        ])
      );
      // Deduped: the attachment's parent task is the same task once.
      expect(result.provenance.filter((s) => s.type === 'task')).toHaveLength(
        1
      );
    });

    it('marks provenance incomplete for an attachment without a parent task id', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'att_1#0',
            score: 0.8,
            metadata: { type: 'document', text: 'Attachment body' },
          },
        ],
      });
      mockDb.attachment.findMany.mockResolvedValue([
        attachmentRow('att_1', 'task_1'),
      ]);

      const result = await retrieveRelevantContextWithProvenance(
        'What is task 1?',
        ORG_A,
        DUMMY_EMBEDDING
      );

      expect(result.provenanceComplete).toBe(false);
    });

    it('marks provenance incomplete for an unknown source kind', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'note_1#0',
            score: 0.8,
            metadata: { type: 'note', text: 'Note body' },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([{ id: 'note_1' }]);

      const result = await retrieveRelevantContextWithProvenance(
        'What is note 1?',
        ORG_A,
        DUMMY_EMBEDDING
      );

      expect(result.provenanceComplete).toBe(false);
    });

    it('marks provenance incomplete when a source vanished after the existence filter', async () => {
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.9,
            metadata: { type: 'task', taskId: 'task_1', text: 'Task body' },
          },
        ],
      });
      // filterActiveRagCandidates sees task_1, but resolveSourceProvenance does not
      mockDb.task.findMany
        .mockResolvedValueOnce([taskRow('task_1')])
        .mockResolvedValueOnce([]);

      const result = await retrieveRelevantContextWithProvenance(
        'What is task 1?',
        ORG_A,
        DUMMY_EMBEDDING
      );

      expect(result.provenanceComplete).toBe(false);
    });

    it('returns an empty context and no provenance when nothing matches', async () => {
      const result = await retrieveRelevantContextWithProvenance(
        'What is task 1?',
        ORG_A,
        DUMMY_EMBEDDING
      );

      expect(result).toEqual({
        context: '',
        provenance: [],
        provenanceComplete: false,
      });
    });

    it('keeps extractTaskIdsFromContext working for legacy callers', () => {
      const formattedBlock =
        '[Context Chunk #1 | Source Task ID: task_abc | Semantic Match: 95%]\nPayload 1\n\n---\n\n' +
        '[Context Chunk #2 | Source Task ID: task_xyz | Semantic Match: 88%]\nPayload 2';

      expect(extractTaskIdsFromContext(formattedBlock)).toEqual([
        'task_abc',
        'task_xyz',
      ]);
    });
  });

  // =========================================================================
  // 10. Route-Level Integration
  // =========================================================================
  describe('POST /api/chat integration', () => {
    function createRequest(body: unknown) {
      return new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const validBody = {
      orgSlug: 'alpha-corp',
      messages: [
        {
          id: 'msg_1',
          role: 'user',
          parts: [{ type: 'text', text: 'How do I start?' }],
        },
      ],
    };

    let capturedOnFinish:
      | ((args: { text: string }) => Promise<void>)
      | undefined;

    beforeEach(() => {
      capturedOnFinish = undefined;
      mockGetOrgAccess.mockResolvedValue({
        userId: USER_A,
        organization: { id: ORG_A, slug: 'alpha-corp' },
        membership: { role: 'MEMBER' },
      });
      mockStreamText.mockImplementation(
        (args: { onFinish?: (input: { text: string }) => Promise<void> }) => {
          capturedOnFinish = args.onFinish;
          return {
            toUIMessageStreamResponse: jest
              .fn()
              .mockReturnValue(
                new Response('stream-ok', {
                  status: 200,
                  headers: { 'X-RateLimit-Remaining': '59' },
                })
              ),
          };
        }
      );
    });

    it('bypasses cache lookup and write when the flag is off', async () => {
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockEmbed).toHaveBeenCalledTimes(1);

      await capturedOnFinish?.({ text: 'Generated answer' });
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockNamespaceUpsert).not.toHaveBeenCalled();
    });

    it('serves a verified cache hit without model generation while validating current sources', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Steps',
              sourceVersion: taskSourceVersion(taskRow('task_1')),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);

      // First request: a miss that writes a genuine entry through onFinish.
      const first = await POST(createRequest(validBody));
      expect(first.status).toBe(200);
      await capturedOnFinish?.({ text: 'Cached: click start.' });

      const writtenKey = mockRedis.set.mock.calls[0][0] as string;
      const writtenPayloadStr = mockRedis.set.mock.calls[0][1] as string;
      const writtenMetadata = mockNamespaceUpsert.mock.calls[0][0].records[0]
        .metadata;

      // Second request with compatible conversation:
      // Validates against current retrieval result, finds source equivalence, serves cache hit!
      mockStreamText.mockClear();
      mockTenantVectorQuery.mockClear();
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Steps',
              sourceVersion: taskSourceVersion(taskRow('task_1')),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);
      mockNamespaceQuery.mockResolvedValueOnce({
        matches: [{ id: writtenKey, score: 0.95, metadata: writtenMetadata }],
      });
      mockRedis.get.mockResolvedValueOnce(writtenPayloadStr);
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Cache-Hit')).toBe('HIT');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('59');
      // Critical check: model generation was SKIPPED on cache hit!
      expect(mockStreamText).not.toHaveBeenCalled();
      // Current RAG retrieval ran exactly once for freshness verification (not duplicated)
      expect(mockTenantVectorQuery).toHaveBeenCalledTimes(1);
      expect(mockEmbed).toHaveBeenCalledTimes(2);
    });

    it('reuses the query embedding on a cache miss and does not repeat retrieval', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Steps',
              sourceVersion: taskSourceVersion(taskRow('task_1')),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      expect(mockEmbed).toHaveBeenCalledTimes(1);
      // Evaluates cache candidates against current retrieval
      expect(mockNamespaceQuery).toHaveBeenCalledTimes(1);
      // Retrieval was executed once and reused for generation (not duplicated on miss)
      expect(mockTenantVectorQuery).toHaveBeenCalledTimes(1);
      expect(mockTenantVectorQuery).toHaveBeenCalledWith(DUMMY_EMBEDDING, 5);
      expect(mockStreamText).toHaveBeenCalledTimes(1);
    });

    it('writes a cache entry using the resolved model ids and captured provenance', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockResolveLanguageModel.mockResolvedValue({
        modelId: 'tenant-language-model',
      });
      mockResolveEmbeddingModel.mockResolvedValue({
        modelId: 'tenant-embedding-model',
      });
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Deployment steps',
              sourceVersion: taskSourceVersion(taskRow('task_1')),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);
      mockNamespaceQuery.mockResolvedValueOnce({ matches: [] });

      await POST(createRequest(validBody));
      await capturedOnFinish?.({ text: 'Use the deploy button.' });

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(mockRedis.set.mock.calls[0][1] as string);
      expect(payload.modelId).toBe('tenant-language-model');
      expect(payload.embeddingModelId).toBe('tenant-embedding-model');
      expect(payload.promptVersion).toBe(PROMPT_VERSION);
      expect(payload.historyFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.queryDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.cacheVersion).toBe('v3');
      expect(payload.sourceCount).toBe(1);
      expect(payload.sourceIds).toEqual(['task_1']);
      expect(payload.sourceVersions).toEqual([taskSource('task_1').version]);

      const metadata = mockNamespaceUpsert.mock.calls[0][0].records[0].metadata;
      expect(metadata.modelId).toBe('tenant-language-model');
      expect(metadata.embeddingModelId).toBe('tenant-embedding-model');
      expect(metadata.cacheVersion).toBe('v3');
      expect(metadata.queryDigest).toBe(payload.queryDigest);
      expect(metadata.sourceIds).toEqual(['task_1']);
    });

    it('does not cache when retrieval produced no provenance', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });
      mockTenantVectorQuery.mockResolvedValueOnce({ matches: [] });

      await POST(createRequest(validBody));
      await capturedOnFinish?.({ text: 'I do not have that information.' });

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
    });

    it('keeps distinct conversation histories out of each other’s cache identity', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockEmbed.mockResolvedValue({ embedding: DUMMY_EMBEDDING });
      mockNamespaceQuery.mockResolvedValue({ matches: [] });
      mockTenantVectorQuery.mockResolvedValue({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: {
              type: 'task',
              taskId: 'task_1',
              text: 'Steps',
              sourceVersion: taskSourceVersion(taskRow('task_1')),
            },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);

      await POST(createRequest(validBody));
      await capturedOnFinish?.({ text: 'First answer' });

      const secondBody = {
        orgSlug: 'alpha-corp',
        messages: [
          ...validBody.messages,
          {
            id: 'msg_2',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Earlier turn' }],
          },
          {
            id: 'msg_3',
            role: 'user',
            parts: [{ type: 'text', text: 'How do I start?' }],
          },
        ],
      };

      await POST(createRequest(secondBody));
      await capturedOnFinish?.({ text: 'Second answer' });

      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      const firstPayload = JSON.parse(
        mockRedis.set.mock.calls[0][1] as string
      );
      const secondPayload = JSON.parse(
        mockRedis.set.mock.calls[1][1] as string
      );
      expect(firstPayload.historyFingerprint).not.toBe(
        secondPayload.historyFingerprint
      );
    });

    it('fails open to fresh generation when Pinecone throws', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockEmbed.mockResolvedValueOnce({ embedding: DUMMY_EMBEDDING });
      mockTenantVectorQuery.mockResolvedValueOnce({
        matches: [
          {
            id: 'task_1#0',
            score: 0.92,
            metadata: { type: 'task', taskId: 'task_1', text: 'Steps' },
          },
        ],
      });
      mockDb.task.findMany.mockResolvedValue([taskRow('task_1')]);
      mockNamespaceQuery.mockRejectedValueOnce(new Error('Pinecone 503'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      expect(mockStreamText).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('preserves genuine AiResolverError as 402/400', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      const resolverError = new AiResolverError(
        'ORGANIZATION_KEY_REQUIRED',
        'Organization embedding key is required.',
        ORG_A,
        'EMBEDDING' as never
      );
      mockEmbed.mockRejectedValueOnce(resolverError);

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(402);
      const json = await res.json();
      expect(json.code).toBe('ORGANIZATION_KEY_REQUIRED');
    });

    it('does not cache when a resolved model id is unavailable', async () => {
      process.env.ENABLE_SEMANTIC_CACHE = 'true';
      mockResolveEmbeddingModel.mockResolvedValue({});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      expect(mockNamespaceQuery).not.toHaveBeenCalled();
      expect(mockStreamText).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});
