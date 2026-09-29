// src/tests/agent/helpers/prisma-double.ts
//
// In-memory prisma double shared between a jest.mock factory and the test body.
//
// It lives in its own module because jest hoists `jest.mock` above the imports,
// so a factory cannot close over a `const` declared in the test file. The
// factory `require`s this module instead, which resolves to the same instance
// the test imports.

type Row = Record<string, unknown>;

export const store = {
  sessions: [] as Row[],
  executions: [] as Row[],
  messages: [] as Row[],
  outbox: [] as Row[],
};

export function resetStore() {
  store.sessions = [];
  store.executions = [];
  store.messages = [];
  store.outbox = [];
}

function matches(row: Row, where: Row): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }

  if (
    where.sessionId !== undefined &&
    row.sessionId !== where.sessionId
  ) {
    return false;
  }

  if (where.userId !== undefined && row.userId !== where.userId) {
    return false;
  }

  if (where.status !== undefined) {
    const expected = where.status as string | { in: string[] };

    // `in` is checked first: comparing a string against the filter object
    // would always be unequal and would short-circuit the list case away.
    if (typeof expected === "object" && expected !== null) {
      if (!expected.in.includes(row.status as string)) {
        return false;
      }
    } else if (row.status !== expected) {
      return false;
    }
  }

  // Date-range predicates. Modelled because the approval-expiry CAS depends on
  // them: a double that ignored `expiresAt` would report every stale proposal
  // as expirable AND every live proposal as expirable, which is precisely the
  // distinction the test is meant to prove.
  for (const field of [
    "expiresAt",
    "updatedAt",
    "createdAt",
    "availableAt",
  ] as const) {
    const condition = where[field];

    if (condition === undefined) continue;

    const value = row[field];

    // A NULL timestamp never satisfies a date predicate, in either direction.
    // SQL agrees: `NULL <= x` is NULL, not true, and Prisma mirrors that. This
    // matters for approval expiry specifically - a proposal with no deadline
    // must NOT match `expiresAt <= now`, or the sweep would close it against a
    // window that was never agreed with anyone.
    if (!(value instanceof Date)) return false;

    if (condition instanceof Date) {
      if (!(value.getTime() <= condition.getTime())) return false;
      continue;
    }

    if (condition && typeof condition === "object") {
      if (
        "lte" in condition &&
        condition.lte instanceof Date &&
        !(value.getTime() <= condition.lte.getTime())
      ) {
        return false;
      }

      if (
        "lt" in condition &&
        condition.lt instanceof Date &&
        !(value.getTime() < condition.lt.getTime())
      ) {
        return false;
      }
    }
  }

  return true;
}

const findFirstSession = async ({ where }: { where: Row }) =>
  store.sessions.find((row) => matches(row, where)) ?? null;

const updateManySessions = async ({
  where,
  data,
}: {
  where: Row;
  data: Row;
}) => {
  const hits = store.sessions.filter((row) => matches(row, where));

  for (const row of hits) {
    Object.assign(row, data);
  }

  return { count: hits.length };
};

const findFirstExecution = async ({ where }: { where: Row }) =>
  store.executions.find((row) => matches(row, where)) ?? null;

// getToolExecutionForWorker resolves a single execution by id and joins the
// session. Modelled because the expiry sweep reads the execution's toolCallId
// and toolName to close the transcript correctly - without a join there is
// nothing to write a well-formed tool-result against.
const findUniqueExecutionWithSession = async ({ where }: { where: Row }) => {
  const row = store.executions.find((r) => r.id === where.id);

  if (!row) return null;

  const session = store.sessions.find((s) => s.id === row.sessionId);

  if (!session) return null;

  return { ...row, session };
};

const updateManyExecutions = async ({
  where,
  data,
}: {
  where: Row;
  data: Row;
}) => {
  const hits = store.executions.filter((row) => matches(row, where));

  for (const row of hits) {
    Object.assign(row, data);
  }

  return { count: hits.length };
};

// Scans filter through the same `matches` helper as findFirst/updateMany, so a
// test that stages a due proposal gets it back and a test that stages a live
// one does not. Returns [] when nothing matches, which is the honest answer
// rather than a blanket empty array that would hide a broken predicate.
const findManyExecutions = async ({ where }: { where?: Row } = {}) => {
  if (!where) return [] as Row[];
  return store.executions.filter((row) => matches(row, where));
};

const createMessageRow = async ({ data }: { data: Row }) => {
  const message = {
    id: `msg_${store.messages.length + 1}`,
    ...data,
  };

  store.messages.push(message);

  return message;
};

const findFirstTask = async () => null as Row | null;

/**
 * Execution creation, honouring the schema's `toolCallId` uniqueness.
 *
 * The unique constraint is asserted because the agent's exactly-once execution
 * story depends on it: two deliveries of the same tool call must not produce two
 * rows, and `id` is what the outbox idempotency key is built from.
 */
let executionSeq = 0;

const createExecution = async ({ data }: { data: Row }) => {
  const duplicate = store.executions.find(
    (row) => row.toolCallId === data.toolCallId,
  );

  if (duplicate) {
    const error = new Error("Unique constraint failed") as Error & {
      code: string;
    };
    error.code = "P2002";
    throw error;
  }

  executionSeq += 1;

  const row = {
    id: `exec_${executionSeq}`,
    error: null,
    confirmedAt: null,
    cancelledAt: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  };

  store.executions.push(row);

  return row;
};

const createSession = async ({ data }: { data: Row }) => {
  const row = { id: `sess_${store.sessions.length + 1}`, ...data };
  store.sessions.push(row);
  return row;
};

const findUniqueSession = async ({ where }: { where: Row }) =>
  store.sessions.find((row) => row.id === where.id) ?? null;

/**
 * updateMany honours the compare-and-set `where` clause rather than blindly
 * applying `data`, so tests exercise the real CAS semantics of the service
 * layer instead of a permissive stub.
 */
// --- outbox -----------------------------------------------------------------
//
// The transactional outbox writes are recorded so tests can assert that a
// domain transition and its delivery intent were produced together. The unique
// idempotencyKey is honoured, because "one logical event per execution" is the
// property most worth protecting and a double that ignored it would let a
// duplicated publish pass unnoticed.

const findUniqueOutbox = async ({ where }: { where: Row }) =>
  store.outbox.find((row) => row.idempotencyKey === where.idempotencyKey) ??
  null;

const upsertOutbox = async ({
  where,
  create,
}: {
  where: Row;
  create: Row;
}) => {
  const existing = store.outbox.find(
    (row) => row.idempotencyKey === where.idempotencyKey,
  );

  if (existing) {
    return existing;
  }

  const row = {
    // Schema defaults are applied here so the double matches what the real
    // client would persist. Without them a test asserting on `status` would be
    // asserting against a gap in the double rather than real behaviour.
    status: "PENDING",
    attempts: 0,
    availableAt: new Date(),
    createdAt: new Date(),
    publishedAt: null,
    lastError: null,
    id: `outbox_${store.outbox.length + 1}`,
    ...create,
  };

  store.outbox.push(row);

  return row;
};

// Filter-aware, because a count that ignored `status` would report delivered
// rows as still pending and make backlog look permanent.
const countOutbox = async ({ where = {} }: { where?: Row } = {}) =>
  store.outbox.filter((row) => matches(row, where)).length;

// Ordered, filtered, capped claim query for the dispatcher. Must honour
// `availableAt` and `status`, or a backoff would be meaningless: the dispatcher
// would immediately re-claim a row it had just pushed into the future.
const findManyOutbox = async ({
  where = {},
  take,
}: { where?: Row; take?: number } = {}) => {
  let rows = store.outbox.filter((row) => matches(row, where));

  rows = [...rows].sort(
    (a, b) =>
      (a.availableAt as Date)?.getTime() - (b.availableAt as Date)?.getTime(),
  );

  if (typeof take === "number") rows = rows.slice(0, take);

  return rows;
};

const updateManyOutbox = async ({
  where,
  data,
}: {
  where: Row;
  data: Row;
}) => {
  // `matches` decides the hit set, so a claim whose `availableAt` predicate no
  // longer holds is correctly skipped. That is what makes the dispatcher's
  // lease observable in tests: an overlapping pass must find zero rows.
  const hits = store.outbox.filter((row) => matches(row, where));

  for (const row of hits) {
    const attempts = data.attempts as { increment: number } | undefined;

    if (attempts && typeof attempts === "object") {
      row.attempts = ((row.attempts as number) ?? 0) + attempts.increment;
    }

    // The lease write is part of the claim, so it has to be applied here. A
    // double that only applied `attempts` would let every pass claim every row
    // and the exclusivity test would pass vacuously.
    for (const [key, value] of Object.entries(data)) {
      if (key === "attempts") continue;
      row[key] = value;
    }
  }

  return { count: hits.length };
};

const updateOutbox = async ({ where, data }: { where: Row; data: Row }) => {
  const row = store.outbox.find((r) => r.id === where.id);

  if (!row) throw new Error("Outbox row not found");

  Object.assign(row, data);

  return row;
};

/**
 * Transactional wrapper.
 *
 * Executes the callback against the same double, so the two writes it performs
 * are visible together. A real rollback is not simulated - the double has no
 * failure injection for that - so a test asserting atomicity here is asserting
 * that the callback ENCLOSES both writes, not that a mid-transaction failure
 * would undo the first. The rollback guarantee is a property of the real
 * database and is covered by the migration and integration verification, not by
 * this double.
 */
/**
 * The self-referential transaction shim.
 *
 * Typed through a named interface rather than `typeof prismaDouble` because the
 * real client hands the callback a client, and writing the parameter's type as
 * the value's own type makes the annotation circular. The interface is the
 * subset of the prisma surface the agent services actually call.
 */
type TransactionCapableDouble = {
  agentSession: { findFirst: unknown; updateMany: unknown };
  agentToolExecution: {
    findFirst: unknown;
    findMany: unknown;
    updateMany: unknown;
  };
  agentMessage: { create: unknown };
  agentOutboxEvent: {
    findUnique: unknown;
    upsert: unknown;
    count: unknown;
  };
  task: { findMany: unknown; findFirst: unknown; update: unknown };
  membership: { findFirst: unknown };
};

const runTransaction = <T>(
  fn: (tx: TransactionCapableDouble) => Promise<T>,
): Promise<T> => fn(prismaDouble);

export const prismaDouble = {
  $transaction: jest.fn(runTransaction),

  agentSession: {
    findFirst: jest.fn(findFirstSession),
    findUnique: jest.fn(findUniqueSession),
    create: jest.fn(createSession),
    updateMany: jest.fn(updateManySessions),
  },

  agentToolExecution: {
    findFirst: jest.fn(findFirstExecution),
    findMany: jest.fn(findManyExecutions),
    findUnique: jest.fn(findUniqueExecutionWithSession),
    create: jest.fn(createExecution),
    updateMany: jest.fn(updateManyExecutions),
  },

  agentMessage: {
    create: jest.fn(createMessageRow),
  },

  /**
   * Task reads and updates.
   *
   * These return whatever the test stages rather than filtering, because the
   * point of the task tests is to assert the `where` clause the code BUILDS:
   * a read that returns correct rows for the wrong reason is still a
   * cross-tenant leak, and only the predicate reveals that.
   */
  task: {
    findMany: jest.fn(findManyExecutions),
    findFirst: jest.fn(findFirstTask),
    update: jest.fn(findFirstTask),
  },

  membership: {
    findFirst: jest.fn(findFirstTask),
  },

  agentOutboxEvent: {
    findUnique: jest.fn(findUniqueOutbox),
    findMany: jest.fn(findManyOutbox),
    upsert: jest.fn(upsertOutbox),
    update: jest.fn(updateOutbox),
    updateMany: jest.fn(updateManyOutbox),
    count: jest.fn(countOutbox),
  },
};

/**
 * Reinstall the real filtering behaviour.
 *
 * `jest.clearAllMocks()` only clears call history, so a test that stubs
 * `updateMany` to return a fixed count leaves that stub in place for every
 * later test in the file - which silently turns the shared double into a
 * permissive stub and makes CAS tests pass without exercising a CAS. Call this
 * before tests that depend on the double actually filtering.
 */
export function restorePrismaDouble(): void {
  prismaDouble.agentSession.findFirst.mockImplementation(findFirstSession);
  prismaDouble.agentSession.findUnique.mockImplementation(findUniqueSession);
  prismaDouble.agentSession.create.mockImplementation(createSession);
  prismaDouble.agentSession.updateMany.mockImplementation(
    updateManySessions,
  );
  prismaDouble.agentToolExecution.create.mockImplementation(createExecution);
  prismaDouble.agentToolExecution.findUnique.mockImplementation(
    findUniqueExecutionWithSession,
  );
  prismaDouble.agentToolExecution.findFirst.mockImplementation(
    findFirstExecution,
  );
  prismaDouble.agentToolExecution.findMany.mockImplementation(
    findManyExecutions,
  );
  prismaDouble.agentToolExecution.updateMany.mockImplementation(
    updateManyExecutions,
  );
  prismaDouble.agentMessage.create.mockImplementation(createMessageRow);
  prismaDouble.task.findMany.mockImplementation(findManyExecutions);
  prismaDouble.task.findFirst.mockImplementation(findFirstTask);
  prismaDouble.task.update.mockImplementation(findFirstTask);
  prismaDouble.membership.findFirst.mockImplementation(findFirstTask);
  prismaDouble.$transaction.mockImplementation(runTransaction);
  prismaDouble.agentOutboxEvent.findUnique.mockImplementation(findUniqueOutbox);
  prismaDouble.agentOutboxEvent.findMany.mockImplementation(findManyOutbox);
  prismaDouble.agentOutboxEvent.upsert.mockImplementation(upsertOutbox);
  prismaDouble.agentOutboxEvent.update.mockImplementation(updateOutbox);
  prismaDouble.agentOutboxEvent.updateMany.mockImplementation(
    updateManyOutbox,
  );
  prismaDouble.agentOutboxEvent.count.mockImplementation(countOutbox);
}
