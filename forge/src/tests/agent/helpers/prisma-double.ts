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
};

export function resetStore() {
  store.sessions = [];
  store.executions = [];
  store.messages = [];
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

const findManyExecutions = async () => [] as Row[];

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
 * updateMany honours the compare-and-set `where` clause rather than blindly
 * applying `data`, so tests exercise the real CAS semantics of the service
 * layer instead of a permissive stub.
 */
export const prismaDouble = {
  agentSession: {
    findFirst: jest.fn(findFirstSession),
    updateMany: jest.fn(updateManySessions),
  },

  agentToolExecution: {
    findFirst: jest.fn(findFirstExecution),
    findMany: jest.fn(findManyExecutions),
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
  prismaDouble.agentSession.updateMany.mockImplementation(
    updateManySessions,
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
}
