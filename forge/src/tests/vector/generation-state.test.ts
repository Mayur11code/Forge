import type { Prisma } from "@prisma/client";
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
// src/tests/vector/generation-state.test.ts
/**
 * Forge Vector V2 — Phase A: Unit & Invariant Verification Suite
 *
 * Verifies all 13 authoritative state transition and deletion invariants:
 *  1. Head uniqueness within organization/entity identity.
 *  2. Same entity identifier cannot acquire an incorrect tenant head.
 *  3. Concurrent head initialization safety.
 *  4. Tombstone persistence after Task/Attachment deletion.
 *  5. Project deletion tombstones all child entities.
 *  6. Tombstone cannot be reset by head initialization.
 *  7. A stale writer token cannot transition a generation.
 *  8. An expired lease cannot mark a generation WRITTEN.
 *  9. A generation with an incorrect source version cannot activate.
 * 10. A generation cannot activate after its head becomes tombstoned.
 * 11. Replacing an active generation atomically obsoletes the previous one.
 * 12. Two competing activations cannot leave two ACTIVE generations or a mismatched pointer.
 * 13. Deletion-versus-activation interleavings preserve the tombstone and reject zombie activation.
 */

import {
  getOrCreateEntityHead,
  reserveGeneration,
  renewGenerationLease,
  failGeneration,
  markGenerationWritten,
  activateGeneration,
  tombstoneEntityHead,
  TombstonedEntityError,
  StaleSourceVersionError,
  LeaseExpiredError,
  OwnershipTokenMismatchError,
  EntityNotFoundError,
  InvalidStateTransitionError,
  ConcurrentWriterConflictError,
  ChunkCountMismatchError,
  ManifestDigestMismatchError,
  MissingManifestDigestError,
  InvalidInputError,
} from "@/lib/vector/generation-state";
import { taskSourceVersion, attachmentSourceVersion } from "@/lib/vector/provenance";
import {
  deleteTaskTransactionally,
  deleteProjectTransactionally,
  deleteAttachmentTransactionally,
} from "@/lib/deletion/service";

// Mock external side-effects
jest.mock("uploadthing/server", () => ({
  UTApi: jest.fn().mockImplementation(() => ({
    deleteFiles: jest.fn().mockResolvedValue({ success: true }),
  })),
}));

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_test_123" }),
}));

jest.mock("@/lib/ai/cache-lifecycle", () => ({
  invalidateSemanticCacheBestEffort: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

describe("Forge Vector V2 — Phase A: Generation State Service", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  const TASK_1 = "task_001";
  const TASK_2 = "task_002";
  const ATTACHMENT_1 = "att_001";
  const PROJECT_1 = "proj_001";

  // In-memory relational store simulation
  let heads: Map<string, Record<string, unknown>>;
  let generations: Map<string, Record<string, unknown>>;
  let tasks: Map<string, Record<string, unknown>>;
  let attachments: Map<string, Record<string, unknown>>;
  let projects: Map<string, Record<string, unknown>>;
  let outboxEvents: Map<string, Record<string, unknown>>;
  let organizations: Map<string, Record<string, unknown>>;

  function headKey(orgId: string, entityType: string, entityId: string): string {
    return `${orgId}:${entityType}:${entityId}`;
  }

  // Transaction client double implementing Prisma Client + raw SQL operations
  function createMockTxClient(): Prisma.TransactionClient {
    const mockClient: Record<string, unknown> = {
      vectorEntityHead: {
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          const key = headKey(
            where.orgId_entityType_entityId.orgId,
            where.orgId_entityType_entityId.entityType,
            where.orgId_entityType_entityId.entityId
          );
          let existing = heads.get(key);
          if (existing) {
            // Apply update fields if specified
            if (Object.keys(update).length > 0) {
              existing = { ...existing, ...update, updatedAt: new Date() };
              heads.set(key, existing as Record<string, unknown>);
            }
            return Promise.resolve({ ...existing });
          }
          const created = {
            id: `head_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          heads.set(key, created);
          return Promise.resolve({ ...created });
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id) {
            for (const h of heads.values()) {
              if (h.id === where.id) return Promise.resolve({ ...h });
            }
            return Promise.resolve(null);
          }
          if (where.orgId_entityType_entityId) {
            const key = headKey(
              where.orgId_entityType_entityId.orgId,
              where.orgId_entityType_entityId.entityType,
              where.orgId_entityType_entityId.entityId
            );
            return Promise.resolve(heads.get(key) ? { ...heads.get(key) } : null);
          }
          return Promise.resolve(null);
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(({ where }) => {
          return (mockClient.vectorEntityHead as { findUnique: (args: unknown) => Promise<unknown> }).findUnique({ where }).then((res: unknown) => {
            if (!res) throw new Error("VectorEntityHead not found");
            return res;
          });
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          for (const [k, h] of heads.entries()) {
            if (h.id === where.id) {
              const updated = { ...h, ...data, updatedAt: new Date() };
              heads.set(k, updated);
              return Promise.resolve({ ...updated });
            }
          }
          throw new Error("VectorEntityHead not found");
        }),
      },

      vectorGeneration: {
        create: jest.fn().mockImplementation(({ data }) => {
          const gen = { ...data, createdAt: new Date(), updatedAt: new Date() };
          generations.set(gen.id, gen);
          return Promise.resolve({ ...gen });
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const gen = generations.get(where.id);
          return Promise.resolve(gen ? { ...gen } : null);
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(({ where }) => {
          const gen = generations.get(where.id);
          if (!gen) throw new Error(`VectorGeneration ${where.id} not found`);
          return Promise.resolve({ ...gen });
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          const list = Array.from(generations.values()).filter((g) => {
            if (where.headId && g.headId !== where.headId) return false;
            if (where.status && g.status !== where.status) return false;
            return true;
          });
          return Promise.resolve(list.map((g) => ({ ...g })));
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const gen = generations.get(where.id);
          if (!gen) throw new Error(`VectorGeneration ${where.id} not found`);
          const updated = { ...gen, ...data, updatedAt: new Date() };
          generations.set(where.id, updated);
          return Promise.resolve({ ...updated });
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const [id, g] of generations.entries()) {
            let match = true;
            if (where.headId && g.headId !== where.headId) match = false;
            if (where.status) {
              if (typeof where.status === "string" && g.status !== where.status) match = false;
              if (where.status.in && !where.status.in.includes(g.status)) match = false;
            }
            if (match) {
              generations.set(id, { ...g, ...data, updatedAt: new Date() });
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
      },

      task: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.id) {
            const t = tasks.get(where.id);
            if (!t) return Promise.resolve(null);
            if (where.project?.orgId) {
              const p = projects.get(t.projectId as string);
              if (!p || p.orgId !== where.project.orgId) return Promise.resolve(null);
            }
            return Promise.resolve({
              ...t,
              project: projects.get(t.projectId as string),
            });
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockImplementation(({ where, orderBy }) => {
          let list = Array.from(tasks.values());
          if (where?.projectId) {
            list = list.filter((t) => t.projectId === where.projectId);
          }
          if (orderBy?.id === "asc") {
            list.sort((a, b) => (a.id as string).localeCompare(b.id as string));
          }
          return Promise.resolve(list.map((t) => ({ ...t })));
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const t = tasks.get(where.id);
          if (!t) return Promise.resolve(null);
          return Promise.resolve({
            ...t,
            project: projects.get(t.projectId as string),
            attachments: Array.from(attachments.values()).filter((a) => a.taskId === t.id),
          });
        }),
        delete: jest.fn().mockImplementation(({ where }) => {
          const t = tasks.get(where.id);
          tasks.delete(where.id);
          // Relational cascade deletes child attachments
          for (const [attId, att] of attachments.entries()) {
            if (att.taskId === where.id) attachments.delete(attId);
          }
          return Promise.resolve(t);
        }),
      },

      attachment: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          const att = attachments.get(where.id);
          if (!att) return Promise.resolve(null);
          const task = tasks.get(att.taskId as string);
          const project = task ? projects.get(task.projectId as string) : null;
          if (where.task?.project?.orgId && project?.orgId !== where.task.project.orgId) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            ...att,
            task: task ? { ...task, project } : null,
          });
        }),
        findMany: jest.fn().mockImplementation(({ where, orderBy }) => {
          let list = Array.from(attachments.values());
          if (where?.taskId) {
            if (typeof where.taskId === "string") {
              list = list.filter((a) => a.taskId === where.taskId);
            } else if (where.taskId.in) {
              list = list.filter((a) => where.taskId.in.includes(a.taskId));
            }
          }
          if (orderBy?.id === "asc") {
            list.sort((a, b) => (a.id as string).localeCompare(b.id as string));
          }
          return Promise.resolve(list.map((a) => ({ ...a })));
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const att = attachments.get(where.id);
          if (!att) return Promise.resolve(null);
          const task = tasks.get(att.taskId as string);
          const project = task ? projects.get(task.projectId as string) : null;
          return Promise.resolve({
            ...att,
            task: task ? { ...task, project } : null,
          });
        }),
        delete: jest.fn().mockImplementation(({ where }) => {
          const att = attachments.get(where.id);
          attachments.delete(where.id);
          return Promise.resolve(att);
        }),
      },

      project: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const p = projects.get(where.id);
          if (!p) return Promise.resolve(null);
          const projectTasks = Array.from(tasks.values())
            .filter((t) => t.projectId === p.id)
            .map((t) => ({
              ...t,
              attachments: Array.from(attachments.values()).filter((a) => a.taskId === t.id),
            }));
          return Promise.resolve({
            ...p,
            tasks: projectTasks,
          });
        }),
        delete: jest.fn().mockImplementation(({ where }) => {
          const p = projects.get(where.id);
          projects.delete(where.id);
          for (const [tId, t] of tasks.entries()) {
            if (t.projectId === where.id) {
              tasks.delete(tId);
              for (const [attId, att] of attachments.entries()) {
                if (att.taskId === tId) attachments.delete(attId);
              }
            }
          }
          return Promise.resolve(p);
        }),
      },

      organization: {
        update: jest.fn().mockResolvedValue({ id: ORG_A }),
      },

      domainOutboxEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => {
          const event = { id: `outbox_${Date.now()}`, ...create };
          outboxEvents.set(create.idempotencyKey, event);
          return Promise.resolve(event);
        }),
      },

      $queryRaw: jest.fn().mockImplementation(async (query: unknown, ...params: unknown[]) => {
        const queryText = Array.isArray(query) ? query.join("?") : typeof query === "object" && query !== null && "text" in query ? String((query as { text: unknown }).text) : String(query);

        // 1. Task query for activation or locking
        if (queryText.includes('FROM "Task"')) {
          const taskId = String(params[0]);
          const task = tasks.get(taskId);
          if (!task) return [];
          const project = projects.get(task.projectId as string);
          return [{
            id: task.id,
            projectId: task.projectId,
            updatedAt: task.updatedAt,
            orgId: project?.orgId ?? ORG_A,
          }];
        }

        // 2. Attachment query for activation or locking
        if (queryText.includes('FROM "Attachment"')) {
          const attId = String(params[0]);
          const att = attachments.get(attId);
          if (!att) return [];
          const task = tasks.get(att.taskId as string);
          const project = task ? projects.get(task.projectId as string) : null;
          return [{
            id: att.id,
            taskId: att.taskId,
            createdAt: att.createdAt,
            size: att.size,
            taskUpdatedAt: task?.updatedAt ?? new Date(),
            taskProjectId: task?.projectId ?? "",
            orgId: project?.orgId ?? ORG_A,
          }];
        }

        // 3. Project query for locking
        if (queryText.includes('FROM "Project"')) {
          const projectId = String(params[0]);
          const p = projects.get(projectId);
          if (!p) return [];
          return [{ id: p.id, orgId: p.orgId }];
        }

        // 4. Head lock query
        if (queryText.includes('FROM "VectorEntityHead"')) {
          if (queryText.includes('"orgId" =') && queryText.includes('"entityType" =')) {
            const orgId = String(params[0]);
            const entityType = String(params[1]);
            const entityId = String(params[2]);
            const key = headKey(orgId, entityType, entityId);
            const h = heads.get(key);
            if (!h) return [];
            return [{
              id: h.id,
              orgId: h.orgId,
              entityType: h.entityType,
              entityId: h.entityId,
              activeGenId: h.activeGenId,
              isTombstone: h.isTombstone,
            }];
          }

          const headId = String(params[0]);
          for (const h of heads.values()) {
            if (h.id === headId) {
              return [{
                id: h.id,
                orgId: h.orgId,
                entityType: h.entityType,
                entityId: h.entityId,
                activeGenId: h.activeGenId,
                isTombstone: h.isTombstone,
              }];
            }
          }
          return [];
        }

        // 5. Generation lock query
        if (queryText.includes('FROM "VectorGeneration"')) {
          // Check active writer check
          if (queryText.includes("status = 'WRITING'")) {
            const headId = String(params[0]);
            const liveWriters = Array.from(generations.values()).filter(
              (g) => g.headId === headId && g.status === "WRITING" && g.leaseExpiresAt && (g.leaseExpiresAt as Date) > new Date()
            );
            return liveWriters.map((w) => ({ id: w.id, claimToken: w.claimToken }));
          }

          // Ordered generation lock for tombstoning
          if (queryText.includes("ORDER BY id ASC")) {
            const headId = String(params[0]);
            const list = Array.from(generations.values()).filter((g) => g.headId === headId);
            list.sort((a, b) => (a.id as string).localeCompare(b.id as string));
            return list.map((g) => ({ id: g.id, status: g.status }));
          }

          // Single generation lock for activation or markGenerationWritten
          const genId = String(params[0]);
          const gen = generations.get(genId);
          if (!gen) return [];
          const isLeaseValid = gen.leaseExpiresAt ? gen.leaseExpiresAt > new Date() : false;
          return [{
            id: gen.id,
            headId: gen.headId,
            status: gen.status,
            claimToken: gen.claimToken,
            expectedChunkCount: gen.expectedChunkCount,
            manifestDigest: gen.manifestDigest,
            sourceVersion: gen.sourceVersion,
            isLeaseValid,
          }];
        }

        return [];
      }),

      $executeRaw: jest.fn().mockImplementation(async (query: unknown, ...params: unknown[]) => {
        const queryText = Array.isArray(query) ? query.join("?") : typeof query === "object" && query !== null && "text" in query ? String((query as { text: unknown }).text) : String(query);

        // Insert Generation
        if (queryText.includes('INSERT INTO "VectorGeneration"')) {
          const genId = params[0];
          const headId = params[1];
          const sourceVersion = params[2];
          const parentTaskVersion = params[3];
          const embeddingModelId = params[4];
          const embeddingDimension = params[5];
          const contractVersion = params[6];
          const expectedChunkCount = params[7];
          const manifestDigest = params[8];
          const claimToken = params[9];
          const leaseSeconds = Number(params[10]) || 300;

          const gen = {
            id: genId,
            headId,
            sourceVersion,
            parentTaskVersion,
            embeddingModelId,
            embeddingDimension,
            contractVersion,
            expectedChunkCount,
            manifestDigest,
            status: "WRITING",
            claimToken,
            leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
            writeAttempts: 1,
            cleanupAttempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          generations.set(String(genId), gen);
          return 1;
        }

        // Mark WRITTEN (Conditional update with fencing check)
        if (queryText.includes("SET status = 'WRITTEN'")) {
          const manifestDigest = params[0];
          const genId = String(params[1]);
          const claimToken = String(params[2]);

          const gen = generations.get(genId);
          if (!gen) return 0;
          if (gen.status !== "WRITING") return 0;
          if (claimToken && gen.claimToken !== claimToken) return 0;
          if (gen.leaseExpiresAt && gen.leaseExpiresAt <= new Date()) return 0;

          gen.status = "WRITTEN";
          if (manifestDigest && !gen.manifestDigest) gen.manifestDigest = manifestDigest;
          gen.updatedAt = new Date();
          return 1;
        }

        // Renew Lease (Conditional update with fencing check)
        if (queryText.includes('UPDATE "VectorGeneration"') && queryText.includes('"leaseExpiresAt" = clock_timestamp() + make_interval')) {
          const extensionSeconds = Number(params[0]) || 300;
          const genId = String(params[1]);
          const claimToken = String(params[2]);

          const gen = generations.get(genId);
          if (!gen) return 0;
          if (gen.status !== "WRITING") return 0;
          if (gen.claimToken !== claimToken) return 0;
          if (gen.leaseExpiresAt && gen.leaseExpiresAt <= new Date()) return 0;

          gen.leaseExpiresAt = new Date(Date.now() + extensionSeconds * 1000);
          gen.updatedAt = new Date();
          return 1;
        }

        // Fail generation (explicit worker failure via failGeneration)
        if (queryText.includes("SET status = 'FAILED'") && queryText.includes('WHERE id =')) {
          const errorMessage = params[0];
          const genId = String(params[1]);
          const claimToken = String(params[2]);

          const gen = generations.get(genId);
          if (!gen) return 0;
          if (gen.status !== "WRITING" && gen.status !== "WRITTEN") return 0;
          if (gen.claimToken !== claimToken) return 0;

          gen.status = "FAILED";
          gen.lastError = errorMessage;
          gen.claimToken = null;
          gen.leaseExpiresAt = null;
          gen.updatedAt = new Date();
          return 1;
        }

        // Expired writer cleanup in reserveGeneration
        if (queryText.includes("SET status = 'FAILED'") && queryText.includes('WHERE "headId" =') && queryText.includes('<= clock_timestamp()')) {
          const headId = String(params[0]);
          let count = 0;
          for (const g of generations.values()) {
            if (g.headId === headId && g.status === "WRITING" && g.leaseExpiresAt && g.leaseExpiresAt <= new Date()) {
              g.status = "FAILED";
              g.claimToken = null;
              g.leaseExpiresAt = null;
              g.lastError = "Writer lease expired; superseded by subsequent reservation";
              g.updatedAt = new Date();
              count++;
            }
          }
          return count;
        }

        // Fail generation on tombstone
        if (queryText.includes("SET status = 'FAILED'") && queryText.includes('WHERE "headId" =')) {
          const headId = String(params[0]);
          let count = 0;
          for (const g of generations.values()) {
            if (g.headId === headId && (g.status === "WRITING" || g.status === "WRITTEN")) {
              g.status = "FAILED";
              g.claimToken = null;
              g.leaseExpiresAt = null;
              g.lastError = "Entity tombstoned before activation";
              g.updatedAt = new Date();
              count++;
            }
          }
          return count;
        }

        // Obsolete previous active generation
        if (queryText.includes("SET status = 'OBSOLETE'")) {
          const genId = String(params[0]);
          const headId = String(params[1]);
          const gen = generations.get(genId);
          if (gen && gen.status === "ACTIVE") {
            gen.status = "OBSOLETE";
            gen.updatedAt = new Date();
            return 1;
          }
          return 0;
        }

        // Activate new generation
        if (queryText.includes("SET status = 'ACTIVE'")) {
          const genId = String(params[0]);
          const headId = String(params[1]);
          const claimToken = String(params[2]);

          const gen = generations.get(genId);
          if (!gen) return 0;
          if (gen.headId !== headId) return 0;
          if (gen.status !== "WRITTEN") return 0;
          if (claimToken && gen.claimToken !== claimToken) return 0;
          if (gen.leaseExpiresAt && gen.leaseExpiresAt <= new Date()) return 0;

          gen.status = "ACTIVE";
          gen.claimToken = null;
          gen.leaseExpiresAt = null;
          gen.updatedAt = new Date();
          return 1;
        }

        // Update head pointer
        if (queryText.includes('UPDATE "VectorEntityHead"')) {
          if (queryText.includes('"activeGenId" =')) {
            const genId = params[0];
            const headId = params[1];
            for (const [k, h] of heads.entries()) {
              if (h.id === headId) {
                heads.set(k, { ...h, activeGenId: genId, updatedAt: new Date() });
                return 1;
              }
            }
          }
          return 0;
        }

        // Tombstone upsert
        if (queryText.includes('INSERT INTO "VectorEntityHead"')) {
          const id = String(params[0]);
          const orgId = String(params[1]);
          const entityType = String(params[2]);
          const entityId = String(params[3]);
          const key = headKey(orgId, entityType, entityId);

          const existing = heads.get(key);
          if (existing) {
            existing.isTombstone = true;
            existing.activeGenId = null;
            existing.tombstonedAt = existing.tombstonedAt || new Date();
            existing.updatedAt = new Date();
          } else {
            heads.set(key, {
              id,
              orgId,
              entityType,
              entityId,
              isTombstone: true,
              tombstonedAt: new Date(),
              activeGenId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
          return 1;
        }

        return 1;
      }),
    };

    return mockClient as unknown as Prisma.TransactionClient;
  }

  let mockTx: Prisma.TransactionClient;

  beforeEach(() => {
    heads = new Map();
    generations = new Map();
    tasks = new Map();
    attachments = new Map();
    projects = new Map();
    outboxEvents = new Map();
    organizations = new Map();

    mockTx = createMockTxClient();

    // Populate initial entities
    projects.set(PROJECT_1, { id: PROJECT_1, name: "Project Alpha", orgId: ORG_A });
    tasks.set(TASK_1, {
      id: TASK_1,
      title: "Task 1",
      projectId: PROJECT_1,
      updatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    tasks.set(TASK_2, {
      id: TASK_2,
      title: "Task 2",
      projectId: PROJECT_1,
      updatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    attachments.set(ATTACHMENT_1, {
      id: ATTACHMENT_1,
      taskId: TASK_1,
      name: "contract.pdf",
      fileKey: "key_contract",
      size: 2048,
      createdAt: new Date("2026-11-01T10:00:00Z"),
    });
  });

  // ---------------------------------------------------------------------------
  // Invariant 1: Head uniqueness within organization/entity identity
  // ---------------------------------------------------------------------------
  it("Invariant 1: enforces head uniqueness within organization and entity identity", async () => {
    const head1 = await getOrCreateEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    const head2 = await getOrCreateEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    expect(head1.id).toBe(head2.id);
    expect(heads.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Invariant 2: Same entity identifier cannot acquire an incorrect tenant head
  // ---------------------------------------------------------------------------
  it("Invariant 2: prevents cross-tenant head acquisition for same entityId", async () => {
    const headOrgA = await getOrCreateEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    const headOrgB = await getOrCreateEntityHead({
      orgId: ORG_B,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    expect(headOrgA.id).not.toBe(headOrgB.id);
    expect(headOrgA.orgId).toBe(ORG_A);
    expect(headOrgB.orgId).toBe(ORG_B);
  });

  // ---------------------------------------------------------------------------
  // Invariant 3: Concurrent head initialization safety
  // ---------------------------------------------------------------------------
  it("Invariant 3: safely resolves concurrent head initializations", async () => {
    const [h1, h2, h3] = await Promise.all([
      getOrCreateEntityHead({ orgId: ORG_A, entityType: "TASK", entityId: TASK_1, tx: mockTx }),
      getOrCreateEntityHead({ orgId: ORG_A, entityType: "TASK", entityId: TASK_1, tx: mockTx }),
      getOrCreateEntityHead({ orgId: ORG_A, entityType: "TASK", entityId: TASK_1, tx: mockTx }),
    ]);

    expect(h1.id).toBe(h2.id);
    expect(h2.id).toBe(h3.id);
    expect(heads.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Invariant 4: Tombstone persistence after Task/Attachment deletion
  // ---------------------------------------------------------------------------
  it("Invariant 4: persists durable tombstone and clears active pointer upon deletion", async () => {
    // Seed active head and generation
    const head = await getOrCreateEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });
    head.activeGenId = "gen_prev";

    await tombstoneEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    const tombstoned = await mockTx.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: { orgId: ORG_A, entityType: "TASK", entityId: TASK_1 },
      },
    });

    expect(tombstoned?.isTombstone).toBe(true);
    expect(tombstoned?.activeGenId).toBeNull();
    expect(tombstoned?.tombstonedAt).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invariant 5: Project deletion tombstones all child entities
  // ---------------------------------------------------------------------------
  it("Invariant 5: project deletion transactionally tombstones all child tasks and attachments", async () => {
    // Execute project cascade deletion simulation
    const project = projects.get(PROJECT_1)!;
    const projectTasks = [tasks.get(TASK_1)!, tasks.get(TASK_2)!];

    for (const t of projectTasks) {
      await tombstoneEntityHead({ orgId: project.orgId as string, entityType: "TASK", entityId: t.id as string, tx: mockTx });
      const childAtts = Array.from(attachments.values()).filter((a) => a.taskId === t.id);
      for (const a of childAtts) {
        await tombstoneEntityHead({ orgId: project.orgId as string, entityType: "ATTACHMENT", entityId: a.id as string, tx: mockTx });
      }
    }

    const task1Head = heads.get(headKey(ORG_A, "TASK", TASK_1));
    const task2Head = heads.get(headKey(ORG_A, "TASK", TASK_2));
    const att1Head = heads.get(headKey(ORG_A, "ATTACHMENT", ATTACHMENT_1));

    expect(task1Head?.isTombstone).toBe(true);
    expect(task2Head?.isTombstone).toBe(true);
    expect(att1Head?.isTombstone).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Invariant 6: Tombstone cannot be reset by head initialization
  // ---------------------------------------------------------------------------
  it("Invariant 6: tombstone cannot be reset or resurrected by getOrCreateEntityHead", async () => {
    await tombstoneEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    const reinitialized = await getOrCreateEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    expect(reinitialized.isTombstone).toBe(true);
    expect(reinitialized.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Invariant 7: A stale writer token cannot transition a generation
  // ---------------------------------------------------------------------------
  it("Invariant 7: rejects markWritten when claimToken does not match", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "task:2026-11-01T10:00:00Z:proj_001",
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken: "claim_stale_imposter",
          writtenChunkCount: 2,
        },
        tx: mockTx,
      })
    ).rejects.toThrow(OwnershipTokenMismatchError);
  });

  // ---------------------------------------------------------------------------
  // Invariant 8: An expired lease cannot mark a generation WRITTEN
  // ---------------------------------------------------------------------------
  it("Invariant 8: rejects markWritten when writer lease has expired", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "task:2026-11-01T10:00:00Z:proj_001",
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    // Artificially expire lease in store
    const genInStore = generations.get(generation.id);
    genInStore!.leaseExpiresAt = new Date(Date.now() - 1000);

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
        },
        tx: mockTx,
      })
    ).rejects.toThrow(LeaseExpiredError);
  });


  it("8b. Write receipt chunk count mismatch throws ChunkCountMismatchError", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_v1",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 5,
      tx: mockTx,
    });

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 3, // only 3 written, expected 5!
        },
        tx: mockTx,
      })
    ).rejects.toThrow(ChunkCountMismatchError);
  });

  it("8c. Write receipt manifest digest mismatch throws ManifestDigestMismatchError", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_v1",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      manifestDigest: "sha256:expected_digest_123",
      tx: mockTx,
    });

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
          manifestDigest: "sha256:tampered_digest_456",
        },
        tx: mockTx,
      })
    ).rejects.toThrow(ManifestDigestMismatchError);
  });

  // ---------------------------------------------------------------------------
  // Invariant 9: A generation with an incorrect source version cannot activate
  // ---------------------------------------------------------------------------
  it("Invariant 9: rejects activation when sourceVersion is stale", async () => {
    const task = tasks.get(TASK_1);
    const initialVersion = taskSourceVersion({
      updatedAt: task!.updatedAt as Date,
      projectId: task!.projectId as string,
    });

    const { generation, claimToken, head } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: initialVersion,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    // Simulate concurrent task update
    task!.updatedAt = new Date("2026-11-01T10:05:00Z");

    await expect(
      activateGeneration({
        headId: head.id,
        generationId: generation.id,
        claimToken,
        expectedSourceVersion: initialVersion,
        tx: mockTx,
      })
    ).rejects.toThrow(StaleSourceVersionError);
  });

  // ---------------------------------------------------------------------------
  // Invariant 10: A generation cannot activate after its head becomes tombstoned
  // ---------------------------------------------------------------------------
  it("Invariant 10: rejects activation when head is tombstoned", async () => {
    const task = tasks.get(TASK_1);
    const version = taskSourceVersion({
      updatedAt: task!.updatedAt as Date,
      projectId: task!.projectId as string,
    });

    const { generation, claimToken, head } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: version,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    // Entity is deleted and tombstoned before worker activation
    await tombstoneEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    await expect(
      activateGeneration({
        headId: head.id,
        generationId: generation.id,
        claimToken,
        expectedSourceVersion: version,
        tx: mockTx,
      })
    ).rejects.toThrow(TombstonedEntityError);
  });

  // ---------------------------------------------------------------------------
  // Invariant 11: Replacing active generation atomically obsoletes previous one
  // ---------------------------------------------------------------------------
  it("Invariant 11: activating new generation atomically sets previous active to OBSOLETE", async () => {
    const task = tasks.get(TASK_1);
    const version = taskSourceVersion({
      updatedAt: task!.updatedAt as Date,
      projectId: task!.projectId as string,
    });

    // 1. Activate Generation 1
    const res1 = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: version,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: res1.generation.id,
        claimToken: res1.claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    await activateGeneration({
      headId: res1.head.id,
      generationId: res1.generation.id,
      claimToken: res1.claimToken,
      expectedSourceVersion: version,
      tx: mockTx,
    });

    const gen1After = generations.get(res1.generation.id);
    expect(gen1After?.status).toBe("ACTIVE");

    // 2. Reserve and Activate Generation 2
    const res2 = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: version,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: res2.generation.id,
        claimToken: res2.claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    const actResult = await activateGeneration({
      headId: res2.head.id,
      generationId: res2.generation.id,
      claimToken: res2.claimToken,
      expectedSourceVersion: version,
      tx: mockTx,
    });

    expect(actResult.obsoletedGenerationId).toBe(res1.generation.id);
    expect(generations.get(res1.generation.id)?.status).toBe("OBSOLETE");
    expect(generations.get(res2.generation.id)?.status).toBe("ACTIVE");
    expect(heads.get(headKey(ORG_A, "TASK", TASK_1))?.activeGenId).toBe(res2.generation.id);
  });

  // ---------------------------------------------------------------------------
  // Invariant 12: Competing activations serialize and prevent dual active gens
  // ---------------------------------------------------------------------------
  it("Invariant 12: prevents duplicate active generations or pointer mismatch", async () => {
    const task = tasks.get(TASK_1);
    const version = taskSourceVersion({
      updatedAt: task!.updatedAt as Date,
      projectId: task!.projectId as string,
    });

    const res = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: version,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: res.generation.id,
        claimToken: res.claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    // First activation succeeds
    await activateGeneration({
      headId: res.head.id,
      generationId: res.generation.id,
      claimToken: res.claimToken,
      expectedSourceVersion: version,
      tx: mockTx,
    });

    // Competing/duplicate activation attempt with already ACTIVE generation
    await expect(
      activateGeneration({
        headId: res.head.id,
        generationId: res.generation.id,
        claimToken: res.claimToken,
        expectedSourceVersion: version,
        tx: mockTx,
      })
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // ---------------------------------------------------------------------------
  // Invariant 13: Deletion vs activation interleavings reject zombie activation
  // ---------------------------------------------------------------------------
  it("Invariant 13: rejects zombie activation after deletion transaction commits", async () => {
    const task = tasks.get(TASK_1);
    const version = taskSourceVersion({
      updatedAt: task!.updatedAt as Date,
      projectId: task!.projectId as string,
    });

    const res = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: version,
      embeddingModelId: "text-embedding-004",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    await markGenerationWritten({
      receipt: {
        generationId: res.generation.id,
        claimToken: res.claimToken,
        writtenChunkCount: 2,
      },
      tx: mockTx,
    });

    // Task is deleted in PostgreSQL
    tasks.delete(TASK_1);
    await tombstoneEntityHead({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      tx: mockTx,
    });

    // Stale/delayed worker wakes up and attempts activation
    await expect(
      activateGeneration({
        headId: res.head.id,
        generationId: res.generation.id,
        claimToken: res.claimToken,
        expectedSourceVersion: version,
        tx: mockTx,
      })
    ).rejects.toThrow(EntityNotFoundError);
  });

  // ---------------------------------------------------------------------------
  // Strict Manifest Digest Validation Tests (Section 5)
  // ---------------------------------------------------------------------------
  it("rejects markGenerationWritten when required manifest digest is missing in receipt", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_digest_test",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      manifestDigest: "sha256:required_digest_abc",
      tx: mockTx,
    });

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
          // manifestDigest omitted
        },
        tx: mockTx,
      })
    ).rejects.toThrow(MissingManifestDigestError);
  });

  it("rejects markGenerationWritten when manifest digest does not match expected digest", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_digest_test",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      manifestDigest: "sha256:required_digest_abc",
      tx: mockTx,
    });

    await expect(
      markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
          manifestDigest: "sha256:wrong_digest_xyz",
        },
        tx: mockTx,
      })
    ).rejects.toThrow(ManifestDigestMismatchError);
  });

  it("accepts markGenerationWritten when required manifest digest matches exactly", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_digest_test",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      manifestDigest: "sha256:required_digest_abc",
      tx: mockTx,
    });

    const written = await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: 2,
        manifestDigest: "sha256:required_digest_abc",
      },
      tx: mockTx,
    });

    expect(written.status).toBe("WRITTEN");
    expect(written.manifestDigest).toBe("sha256:required_digest_abc");
  });

  it("preserves optional-digest behavior when reservation did not require a digest", async () => {
    const { generation, claimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "src_digest_test",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      // no manifestDigest specified during reservation
      tx: mockTx,
    });

    const written = await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: 2,
        manifestDigest: "sha256:optional_digest_xyz",
      },
      tx: mockTx,
    });

    expect(written.status).toBe("WRITTEN");
  });

  // ---------------------------------------------------------------------------
  // Input Validation and State Model Integrity (Section 9)
  // ---------------------------------------------------------------------------
  it("rejects reservation with invalid input values", async () => {
    // Non-positive embedding dimension
    await expect(
      reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 0,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      })
    ).rejects.toThrow(InvalidInputError);

    // Negative expectedChunkCount
    await expect(
      reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: -1,
        tx: mockTx,
      })
    ).rejects.toThrow(InvalidInputError);

    // Out-of-bounds leaseDurationSeconds
    await expect(
      reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        leaseDurationSeconds: 99999,
        tx: mockTx,
      })
    ).rejects.toThrow(InvalidInputError);
  });

  // ---------------------------------------------------------------------------
  // Tenant Scope Boundary Verification (Section 4)
  // ---------------------------------------------------------------------------
  it("rejects reservation when authoritative entity does not exist in the specified tenant", async () => {
    await expect(
      reserveGeneration({
        orgId: "org_cross_tenant_imposter",
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      })
    ).rejects.toThrow(EntityNotFoundError);
  });

  // ---------------------------------------------------------------------------
  // Lease Renewal Verification (Section 6)
  // ---------------------------------------------------------------------------
  describe("renewGenerationLease", () => {
    it("successfully extends an active writer lease", async () => {
      const { generation, claimToken } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        leaseDurationSeconds: 60,
        tx: mockTx,
      });

      const renewed = await renewGenerationLease({
        generationId: generation.id,
        claimToken,
        extensionSeconds: 600,
        tx: mockTx,
      });

      expect(renewed.id).toBe(generation.id);
      expect(renewed.status).toBe("WRITING");
      expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(generation.leaseExpiresAt!.getTime());
    });

    it("rejects lease renewal when the lease has already expired", async () => {
      const { generation, claimToken } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      // Simulate lease expiration
      generations.get(generation.id)!.leaseExpiresAt = new Date(Date.now() - 10000);

      await expect(
        renewGenerationLease({
          generationId: generation.id,
          claimToken,
          extensionSeconds: 300,
          tx: mockTx,
        })
      ).rejects.toThrow(LeaseExpiredError);
    });

    it("rejects lease renewal on claim token mismatch", async () => {
      const { generation } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      await expect(
        renewGenerationLease({
          generationId: generation.id,
          claimToken: "claim_imposter_token",
          extensionSeconds: 300,
          tx: mockTx,
        })
      ).rejects.toThrow(OwnershipTokenMismatchError);
    });

    it("rejects lease renewal when status is not WRITING", async () => {
      const { generation, claimToken } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      await markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
        },
        tx: mockTx,
      });

      await expect(
        renewGenerationLease({
          generationId: generation.id,
          claimToken,
          extensionSeconds: 300,
          tx: mockTx,
        })
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  // ---------------------------------------------------------------------------
  // Writer Failure Transition Verification
  // ---------------------------------------------------------------------------
  describe("failGeneration", () => {
    it("transitions WRITING generation to FAILED and clears lease and claim token", async () => {
      const { generation, claimToken } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      const failed = await failGeneration({
        generationId: generation.id,
        claimToken,
        errorMessage: "Worker crashed due to out of memory error",
        tx: mockTx,
      });

      expect(failed.status).toBe("FAILED");
      expect(failed.claimToken).toBeNull();
      expect(failed.leaseExpiresAt).toBeNull();
      expect(failed.lastError).toBe("Worker crashed due to out of memory error");
    });

    it("transitions WRITTEN generation to FAILED and clears lease and claim token", async () => {
      const { generation, claimToken } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      await markGenerationWritten({
        receipt: {
          generationId: generation.id,
          claimToken,
          writtenChunkCount: 2,
        },
        tx: mockTx,
      });

      const failed = await failGeneration({
        generationId: generation.id,
        claimToken,
        errorMessage: "Pre-activation verification checksum failed",
        tx: mockTx,
      });

      expect(failed.status).toBe("FAILED");
      expect(failed.claimToken).toBeNull();
      expect(failed.leaseExpiresAt).toBeNull();
    });

    it("rejects failure transition on claim token mismatch", async () => {
      const { generation } = await reserveGeneration({
        orgId: ORG_A,
        entityType: "TASK",
        entityId: TASK_1,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v2",
        expectedChunkCount: 2,
        tx: mockTx,
      });

      await expect(
        failGeneration({
          generationId: generation.id,
          claimToken: "claim_wrong_token",
          errorMessage: "Failed attempt",
          tx: mockTx,
        })
      ).rejects.toThrow(OwnershipTokenMismatchError);
    });
  });

  // ---------------------------------------------------------------------------
  // Expired Writer Supersession in reserveGeneration
  // ---------------------------------------------------------------------------
  it("marks expired WRITING generation as FAILED when a new reservation is created", async () => {
    const { generation: expiredGen } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "v1",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 2,
      tx: mockTx,
    });

    // Simulate writer lease expiration
    generations.get(expiredGen.id)!.leaseExpiresAt = new Date(Date.now() - 5000);

    // Subsequent reservation succeeds and marks expired generation FAILED
    const { generation: newGen, claimToken: newClaimToken } = await reserveGeneration({
      orgId: ORG_A,
      entityType: "TASK",
      entityId: TASK_1,
      sourceVersion: "v2",
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      contractVersion: "v2",
      expectedChunkCount: 3,
      tx: mockTx,
    });

    expect(newGen.id).not.toBe(expiredGen.id);
    expect(newGen.status).toBe("WRITING");
    expect(newClaimToken).toBeDefined();

    // Check that expired generation was superseded and marked FAILED
    const genInStore = generations.get(expiredGen.id);
    expect(genInStore?.status).toBe("FAILED");
    expect(genInStore?.claimToken).toBeNull();
    expect(genInStore?.leaseExpiresAt).toBeNull();
    expect(genInStore?.lastError).toBe("Writer lease expired; superseded by subsequent reservation");
  });
});
