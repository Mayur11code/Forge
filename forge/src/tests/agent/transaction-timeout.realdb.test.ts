// src/tests/agent/transaction-timeout.realdb.test.ts
//
// Assignment 37.16 — REAL-DATABASE reproduction of the live P2028 failure and
// proof that the raised transaction ceiling prevents it.
//
// THE DEFECT
// ----------
// The live capstone stalled at agent step 1 with:
//
//   PrismaClientKnownRequestError (P2028): A commit cannot be executed on an
//   expired transaction. The timeout for this transaction was 5000 ms, however
//   12177 ms passed since the start of the transaction.
//
// The agent's transaction bodies were correct. The COMMIT was refused because
// Prisma's default interactive-transaction ceiling is 5000 ms, which is tuned
// for a LOCAL database, and this database is a remote Neon instance reached
// over the public internet.
//
// WHY THIS FILE EXISTS
// --------------------
// The mocked suite in `src/tests/agent/transaction-timeout.test.ts` can only
// assert that the options are PASSED. It cannot show that the default ceiling
// actually aborts a commit, because the prisma double resolves instantly. This
// suite shows both halves against the real Postgres named by DATABASE_URL:
//
//   1. the DEFAULT ceiling aborts a commit that takes longer than 5000 ms
//      (the defect, reproduced); and
//   2. the shared agent options let the very same transaction commit.
//
// The slow transaction is produced with `pg_sleep`, which holds the
// transaction open WITHOUT writing anything. This suite therefore creates no
// rows, mutates no data, and leaves no fixtures behind.
//
// Run it with the real-DB config (NOT the default one):
//
//   npx jest --config jest.realdb.config.ts \
//     src/tests/agent/transaction-timeout.realdb.test.ts

import { db } from "@/lib/prisma/db";
import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options";

// A cold Neon connection can take tens of seconds, and the two cases below
// deliberately hold a transaction open for 8 seconds each.
jest.setTimeout(180_000);

// Long enough to exceed Prisma's 5000 ms default, short enough to sit well
// inside the raised ceiling.
const HOLD_MS = 8;

// `pg_sleep` returns `void`, which Prisma cannot deserialize, so the sleep is
// driven from the FROM clause and a real column is selected instead. The query
// must SUCCEED: the subject under test is the COMMIT that follows it, and a
// failed query would abort the transaction for the wrong reason.
const HOLD_SQL = `SELECT 1 AS ok FROM pg_sleep(${HOLD_MS})`;

describe("interactive-transaction ceiling against a real remote database", () => {
  it("refuses the commit when the default 5000 ms timeout is exceeded", async () => {
    let thrown: unknown;
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(HOLD_SQL);
          return true;
        },
        // maxWait is raised so that connection acquisition is not what fails;
        // `timeout` is deliberately left at Prisma's default so that the
        // assertion isolates the timeout ceiling and nothing else.
        { maxWait: AGENT_TRANSACTION_OPTIONS.maxWait },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const code = (thrown as { code?: string }).code;
    const message = (thrown as Error).message;
    // Prisma refuses the COMMIT once the transaction's own ceiling has passed.
    expect(code).toBe("P2028");
    expect(message).toMatch(/expired transaction/i);
  });

  it("commits the same transaction under the shared agent options", async () => {
    await expect(
      db.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(HOLD_SQL);
          return true;
        },
        AGENT_TRANSACTION_OPTIONS,
      ),
    ).resolves.toBe(true);
  });
});
