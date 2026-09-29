// src/tests/workflow/helpers/prisma-double.ts
//
// In-memory prisma double for the workflow engine.
//
// It lives in its own module because jest hoists `jest.mock` above the imports,
// so a factory cannot close over a `const` declared in the test file. The
// factory `require`s this module instead, which resolves to the same instance
// the test imports.
//
// Two things are modelled deliberately rather than stubbed permissively,
// because both are the properties the workflow regression tests exist to prove:
//
//   1. `StepRun`'s `@@unique([runId, stepId])`. The evaluator relies on P2002 to
//      neutralise a duplicate step creation, and the wrapper relies on the same
//      constraint surviving a crash. A double that let duplicates through would
//      make the ghost-worker guard pass for the wrong reason.
//   2. Every `updateMany` compare-and-set. `wrapper.ts` claims a step by
//      `where: { id, status }`; if the double ignored the status predicate the
//      idempotency test would pass because the update happened, not because the
//      claim was exclusive.

type Row = Record<string, unknown>;

/** The `{ run: { workflow: true } }` nesting the workflow route asks for. */
type RunInclude = { workflow?: boolean } | undefined;

function attachRun(result: Row, include: Row | undefined) {
  if (!include?.run) return;

  const runInclude = include.run as RunInclude;
  const row = store.stepRuns.find((s) => s.id === result.id);
  const run = row
    ? (store.runs.find((r) => r.id === row.runId) ?? null)
    : null;

  const nested: Row = run ? { ...run } : {};

  if (runInclude?.workflow) {
    nested.workflow = run
      ? (store.workflows.find((w) => w.id === run.workflowId) ?? null)
      : null;
  }

  result.run = nested;
}

export const store = {
  workflows: [] as Row[],
  runs: [] as Row[],
  stepRuns: [] as Row[],
  auditLogs: [] as Row[],
};

export function resetStore() {
  store.workflows = [];
  store.runs = [];
  store.stepRuns = [];
  store.auditLogs = [];
  stepRunSeq = 0;
  auditSeq = 0;
}

let stepRunSeq = 0;
let auditSeq = 0;

function uniqueStepRunViolation(): never {
  const error = new Error(
    "Unique constraint failed on the fields: (`runId`,`stepId`)",
  ) as Error & { code: string };
  error.code = "P2002";
  throw error;
}

function matchesStepId(row: Row, condition: unknown): boolean {
  if (condition === undefined) return true;

  if (condition !== null && typeof condition === "object" && "in" in condition) {
    return (condition as { in: unknown[] }).in.includes(row.stepId as string);
  }

  return row.stepId === condition;
}

/**
 * Status predicate: a bare value, or `{ in: [...] }`.
 *
 * `updateMany` is where a sloppy double does the most damage. Comparing
 * `row.status !== where.status` against a `{ in: [...] }` object is never
 * equal, so every compare-and-set silently matches zero rows. The step claim
 * then looks like a refused claim, and the wrapper reports "already processed"
 * on a step nobody had touched - the exact ghost-execution symptom the retry
 * tests exist to catch, arriving from the test harness instead of the code.
 */
function matchesStatus(row: Row, condition: unknown): boolean {
  if (condition === undefined) return true;

  if (condition !== null && typeof condition === "object" && "in" in condition) {
    return (condition as { in: unknown[] }).in.includes(row.status as string);
  }

  return row.status === condition;
}

/**
 * `lt` on a nullable timestamp, faithful to SQL three-valued logic.
 *
 * Modelled because the stale-run sweep is decided entirely by it, and a double
 * that ignored the predicate would sweep every non-terminal run on the first
 * tick - including runs that are mid-flight and completely healthy.
 *
 * A NULL timestamp does not satisfy `lt`: `NULL < x` is NULL, not true. That is
 * the same reason the sweep carries an explicit `OR` for never-advanced runs
 * rather than relying on this predicate to find them.
 */
function matchesDateLtOn(field: string, row: Row, condition: unknown): boolean {
  if (condition === undefined) return true;

  if (condition === null) return row[field] === null || row[field] === undefined;

  if (
    condition !== null &&
    typeof condition === "object" &&
    "lt" in condition &&
    (condition as { lt: unknown }).lt instanceof Date
  ) {
    const value = row[field];
    if (!(value instanceof Date)) return false;
    return value.getTime() < (condition as { lt: Date }).lt.getTime();
  }

  return true;
}

/**
 * WorkflowRun read, honouring the two relations the evaluator needs.
 *
 * The joined copy is a fresh object each call so a test that mutates a returned
 * snapshot is not silently writing through to the store. The evaluator's whole
 * correctness argument is that it re-reads, so handing back a live reference
 * would fake away the very race under test.
 */
const findUniqueRun = async ({
  where,
  include,
  select,
}: {
  where: Row;
  include?: Row;
  select?: Row;
}) => {
  const run = store.runs.find((row) => row.id === where.id);
  if (!run) return null;

  if (select) {
    const picked: Row = {};
    for (const field of Object.keys(select)) {
      if (select[field]) picked[field] = run[field];
    }
    return picked;
  }

  const result: Row = { ...run };

  if (include?.workflow) {
    result.workflow = store.workflows.find((w) => w.id === run.workflowId) ?? null;
  }

  if (include?.stepRuns) {
    result.stepRuns = store.stepRuns
      .filter((s) => s.runId === run.id)
      .map((s) => ({ ...s }));
  }

  return result;
};

const updateRun = async ({ where, data }: { where: Row; data: Row }) => {
  const run = store.runs.find((row) => row.id === where.id);
  if (!run) throw new Error(`WorkflowRun ${String(where.id)} not found`);

  Object.assign(run, data);
  return { ...run };
};

/**
 * Compare-and-set aware `updateMany` on runs.
 *
 * Exists for the context merge, which decides whether it may write by comparing
 * `contextVersion` against the value it read. If this ignored that predicate the
 * merge would appear to succeed on the first attempt every time, and the
 * lost-update test would pass while the production code was still broken.
 */
const updateManyRuns = async ({ where, data }: { where: Row; data: Row }) => {
  const hits = store.runs.filter((row) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (
      where.contextVersion !== undefined &&
      row.contextVersion !== where.contextVersion
    ) {
      return false;
    }
    if (where.status !== undefined && !matchesStatus(row, where.status)) {
      return false;
    }
    return true;
  });

  for (const row of hits) {
    for (const [key, value] of Object.entries(data)) {
      const increment = value as { increment?: number } | undefined;

      if (increment && typeof increment === "object" && increment.increment) {
        row[key] = ((row[key] as number) ?? 0) + increment.increment;
        continue;
      }

      row[key] = value;
    }
  }

  return { count: hits.length };
};

/**
 * One `OR` branch, as a conjunction.
 *
 * Every predicate in the branch must hold, so this cannot stop at the first key
 * it recognises. The never-advanced clause has two - `lastAdvancedAt: null` and
 * `startedAt: { lt: cutoff }` - and short-circuiting after the first would apply
 * the aged fallback to runs of any age, sweeping a workflow that started a second
 * ago.
 */
function matchesOrClause(row: Row, clause: Row): boolean {
  if (clause.lastAdvancedAt !== undefined) {
    if (!matchesDateLtOn("lastAdvancedAt", row, clause.lastAdvancedAt)) return false;
  }

  if (clause.startedAt !== undefined) {
    if (!matchesDateLtOn("startedAt", row, clause.startedAt)) return false;
  }

  if (clause.status !== undefined && !matchesStatus(row, clause.status)) {
    return false;
  }

  return true;
}

/**
 * Top-level `where` for the stale-run sweep.
 *
 * `OR` is modelled because the sweep genuinely needs it: never-advanced runs are
 * excluded by a `lt` on a NULL timestamp, so reaching them requires a second
 * disjunct. A double that ignored `OR` would match every row on the first
 * disjunct and hide the case entirely.
 */
function runMatchesWhere(row: Row, where: Row): boolean {
  if (!matchesStatus(row, where.status)) return false;

  if (
    where.completedAt === null &&
    row.completedAt !== null &&
    row.completedAt !== undefined
  ) {
    return false;
  }

  if (
    where.startedAt !== undefined &&
    !matchesDateLtOn("startedAt", row, where.startedAt)
  ) {
    return false;
  }

  if (where.OR !== undefined) {
    const branches = (where.OR as Row[]).map((clause) => matchesOrClause(row, clause));
    if (!branches.some(Boolean)) return false;
  }

  return matchesDateLtOn("lastAdvancedAt", row, where.lastAdvancedAt);
}

/**
 * The stale-run sweep's query: filtered, ordered oldest-first, and capped.
 *
 * Ordered and capped because both are the difference between a maintenance pass
 * that is cheap and one that is a table scan. `orderBy` matters just as much -
 * sweeping newest-first would starve the oldest stuck runs indefinitely.
 */
const findManyRuns = async ({
  where = {},
  select,
  orderBy,
  take,
}: {
  where?: Row;
  select?: Row;
  orderBy?: Row;
  take?: number;
} = {}) => {
  let rows = store.runs.filter((row) => runMatchesWhere(row, where));

  if (orderBy?.lastAdvancedAt) {
    const direction = orderBy.lastAdvancedAt === "desc" ? -1 : 1;
    const asTime = (row: Row) =>
      row.lastAdvancedAt instanceof Date
        ? row.lastAdvancedAt.getTime()
        : Number.POSITIVE_INFINITY;

    rows = [...rows].sort(
      (a, b) => direction * (asTime(a) - asTime(b)),
    );
  }

  if (typeof take === "number") rows = rows.slice(0, take);

  return rows.map((row) => {
    if (!select?.stepRuns) return { ...row };

    const picked: Row = {};
    for (const field of Object.keys(select)) {
      if (!select[field]) continue;
      if (field === "stepRuns") {
        picked.stepRuns = store.stepRuns
          .filter((s) => s.runId === row.id)
          .map((s) => ({ ...s }));
      } else {
        picked[field] = row[field];
      }
    }
    return picked;
  });
};

const createStepRun = async ({ data }: { data: Row }) => {
  if (
    store.stepRuns.some(
      (s) => s.runId === data.runId && s.stepId === data.stepId,
    )
  ) {
    uniqueStepRunViolation();
  }

  stepRunSeq += 1;

  const row: Row = {
    id: `sr_${stepRunSeq}`,
    status: "PENDING",
    attempts: 0,
    compensationAttempts: 0,
    inputs: null,
    outputs: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...data,
  };

  store.stepRuns.push(row);
  return { ...row };
};

/**
 * `createMany` honours the same uniqueness rule as `create`.
 *
 * Prisma's `createMany` omits `skipDuplicates`, so a duplicate raises P2002
 * rather than being quietly dropped. Modelled faithfully so a concurrent
 * evaluator pass writing CANCELLED/SKIPPED rows surfaces as the error it
 * actually is, instead of passing a test with a double that invented a
 * `skipDuplicates` the production call does not have.
 */
const createManyStepRuns = async ({ data }: { data: Row[] }) => {
  for (const entry of data) {
    if (
      store.stepRuns.some(
        (s) => s.runId === entry.runId && s.stepId === entry.stepId,
      )
    ) {
      uniqueStepRunViolation();
    }
  }

  for (const entry of data) {
    stepRunSeq += 1;
    store.stepRuns.push({
      id: `sr_${stepRunSeq}`,
      status: "PENDING",
      attempts: 0,
      compensationAttempts: 0,
      inputs: null,
      outputs: null,
      error: null,
      startedAt: null,
      completedAt: null,
      ...entry,
    });
  }

  return { count: data.length };
};

const findManyStepRuns = async ({ where }: { where?: Row } = {}) => {
  return store.stepRuns
    .filter((row) => (where?.runId === undefined ? true : row.runId === where.runId))
    .map((row) => ({ ...row }));
};

const findFirstStepRun = async ({
  where,
  include,
}: {
  where: Row;
  include?: Row;
}) => {
  const row = store.stepRuns.find(
    (s) =>
      (where.runId === undefined || s.runId === where.runId) &&
      matchesStepId(s, where.stepId),
  );

  if (!row) return null;

  const result: Row = { ...row };
  attachRun(result, include);

  return result;
};

const findUniqueStepRun = async ({
  where,
  include,
}: {
  where: Row;
  include?: Row;
}) => {
  const row = store.stepRuns.find((s) => s.id === where.id);
  if (!row) return null;

  const result: Row = { ...row };
  attachRun(result, include);

  return result;
};

const updateStepRun = async ({ where, data }: { where: Row; data: Row }) => {
  const row = store.stepRuns.find((s) => s.id === where.id);
  if (!row) throw new Error(`StepRun ${String(where.id)} not found`);

  Object.assign(row, data);
  return { ...row };
};

/**
 * Compare-and-set aware `updateMany`.
 *
 * The hit set is decided by the predicates - `id`, `status`, `runId` and the
 * `stepId: { in: [...] }` list - so a claim that no longer matches its target
 * status is correctly skipped. That is what makes the wrapper's exclusivity
 * observable: without it, "already claimed" would pass because the update
 * happened rather than because the claim was refused.
 */
const updateManyStepRuns = async ({
  where,
  data,
}: {
  where: Row;
  data: Row;
}) => {
  const hits = store.stepRuns.filter((row) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && !matchesStatus(row, where.status)) return false;
    if (where.runId !== undefined && row.runId !== where.runId) return false;
    if (!matchesStepId(row, where.stepId)) return false;
    return true;
  });

  for (const row of hits) {
    Object.assign(row, data);
  }

  return { count: hits.length };
};

const createAuditLog = async ({ data }: { data: Row }) => {
  auditSeq += 1;

  const row: Row = {
    id: `audit_${auditSeq}`,
    logLevel: "INFO",
    latencyMs: null,
    payload: null,
    createdAt: new Date(),
    ...data,
  };

  store.auditLogs.push(row);
  return { ...row };
};

/**
 * Transactional wrapper, in both of Prisma's shapes.
 *
 * Callback form runs the function against the same double. Array form is
 * awaited in order, which is what the stale-run sweep uses to pair a step's
 * status change with the audit row that explains it.
 *
 * A real rollback is NOT simulated in either form: there is no failure injection,
 * so a test asserting atomicity here is asserting that the writes are ENCLOSED,
 * not that a mid-transaction failure would undo the first. That guarantee belongs
 * to Postgres and is covered by the migration and live verification, not here.
 */
type TransactionCapableDouble = {
  stepRun: { update: unknown; create: unknown; updateMany: unknown };
  workflowRun: { update: unknown; updateMany: unknown; findUnique: unknown };
  executionAuditLog: { create: unknown };
};

const runTransaction = <T>(
  fn: (tx: TransactionCapableDouble) => Promise<T>,
): Promise<T> => fn(prismaDouble as unknown as TransactionCapableDouble);

/**
 * Array form, awaited in order.
 *
 * Prisma's array form takes already-constructed `PrismaPromise`s, not thunks, so
 * the entries are awaited directly. Thunks are also accepted because the
 * distinction is invisible at the call site and an easy thing to get wrong: the
 * alternative - calling every entry - throws `operation is not a function` on the
 * first promise, and only on the failure paths that reach it.
 */
const runTransactionArray = async (
  operations: Array<Promise<unknown> | (() => Promise<unknown>)>,
): Promise<unknown[]> => {
  const results: unknown[] = [];
  for (const operation of operations) {
    results.push(
      typeof operation === "function"
        ? await (operation as () => Promise<unknown>)()
        : await operation,
    );
  }
  return results;
};

/**
 * The un-mocked transaction body.
 *
 * Kept separate from the `jest.fn` that wraps it. Restoring a mock from itself
 * - `mock.mockImplementation(realImplementations.transaction)` where that
 * property IS the mock - makes every call recurse until the stack gives out,
 * which surfaces as `RangeError: Maximum call stack size exceeded` at the
 * assertion rather than as the bug it actually is.
 */
const transactionImpl = (arg: unknown) => {
  if (Array.isArray(arg)) {
    return runTransactionArray(
      arg as Array<Promise<unknown> | (() => Promise<unknown>)>,
    );
  }
  return runTransaction(arg as (tx: TransactionCapableDouble) => Promise<unknown>);
};

const transaction = jest.fn(transactionImpl);

/**
 * The double's shape, written out so `$extends` can return it.
 *
 * `$extends` refers to `prismaDouble` from inside its own initializer, so
 * without this annotation TypeScript cannot infer the type and reports the const
 * as an implicit `any` - the circular reference defeats inference.
 */
type PrismaDouble = {
  $transaction: typeof transaction;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $extends: jest.Mock;
  workflowRun: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  stepRun: {
    create: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  executionAuditLog: { create: jest.Mock };
};

/**
 * `$extends` and the lifecycle no-ops.
 *
 * `src/lib/prisma/extended.ts` calls `db.$extends({...})` at module scope, and
 * several modules in the workflow engine's import graph reach it. Without this,
 * the double is only usable from a test that happens to mock every one of those
 * modules - which is a property of the test rather than of the code, and it
 * breaks the moment an import is added for an unrelated reason.
 *
 * Returning the double itself is faithful: Prisma's `$extends` returns a client
 * carrying the same model delegates, which is all the workflow engine uses. The
 * audit-logging extension is not modelled, because nothing under test reads it.
 */
const lifecycleNoop = async () => undefined;

const extend = jest.fn((): PrismaDouble => prismaDouble);

export const prismaDouble: PrismaDouble = {
  $transaction: transaction,
  $connect: lifecycleNoop,
  $disconnect: lifecycleNoop,
  $extends: extend,

  workflowRun: {
    findUnique: jest.fn(findUniqueRun),
    findMany: jest.fn(findManyRuns),
    update: jest.fn(updateRun),
    updateMany: jest.fn(updateManyRuns),
  },

  stepRun: {
    create: jest.fn(createStepRun),
    createMany: jest.fn(createManyStepRuns),
    findMany: jest.fn(findManyStepRuns),
    findFirst: jest.fn(findFirstStepRun),
    findUnique: jest.fn(findUniqueStepRun),
    update: jest.fn(updateStepRun),
    updateMany: jest.fn(updateManyStepRuns),
  },

  executionAuditLog: {
    create: jest.fn(createAuditLog),
  },
};

const realImplementations = {
  findUniqueRun,
  findManyRuns,
  updateRun,
  updateManyRuns,
  createStepRun,
  createManyStepRuns,
  findManyStepRuns,
  findFirstStepRun,
  findUniqueStepRun,
  updateStepRun,
  updateManyStepRuns,
  createAuditLog,
  runTransaction,
  runTransactionArray,
  transaction: transactionImpl,
  $extends: extend,
};

/**
 * Reinstall the real filtering behaviour.
 *
 * `jest.clearAllMocks()` only clears call history, so a test that stubs
 * `updateMany` to return a fixed count leaves that stub in place for every
 * later test in the file - which silently turns the shared double into a
 * permissive stub and makes CAS tests pass without exercising a CAS.
 */
export function restoreWorkflowDouble(): void {
  prismaDouble.workflowRun.findUnique.mockImplementation(realImplementations.findUniqueRun);
  prismaDouble.workflowRun.findMany.mockImplementation(realImplementations.findManyRuns);
  prismaDouble.workflowRun.update.mockImplementation(realImplementations.updateRun);
  prismaDouble.workflowRun.updateMany.mockImplementation(realImplementations.updateManyRuns);
  prismaDouble.stepRun.create.mockImplementation(realImplementations.createStepRun);
  prismaDouble.stepRun.createMany.mockImplementation(
    realImplementations.createManyStepRuns,
  );
  prismaDouble.stepRun.findMany.mockImplementation(realImplementations.findManyStepRuns);
  prismaDouble.stepRun.findFirst.mockImplementation(realImplementations.findFirstStepRun);
  prismaDouble.stepRun.findUnique.mockImplementation(realImplementations.findUniqueStepRun);
  prismaDouble.stepRun.update.mockImplementation(realImplementations.updateStepRun);
  prismaDouble.stepRun.updateMany.mockImplementation(
    realImplementations.updateManyStepRuns,
  );
  prismaDouble.executionAuditLog.create.mockImplementation(
    realImplementations.createAuditLog,
  );
  prismaDouble.$transaction.mockImplementation(realImplementations.transaction);
  prismaDouble.$extends.mockImplementation(realImplementations.$extends);
}
