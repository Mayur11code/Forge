// jest.setup-db-guard.ts
//
// Fails the test run if a test opens a real database connection.
//
// The hazard this closes: agent code reaches the database through TWO modules,
// `prisma/extended` (domain queries, and the only one the doubles replace) and
// `prisma/db` (the raw client used for the transactional outbox paths). A test
// that mocked only the first would silently use the second, and because
// `next/jest` loads the real `.env`, that connection points at whatever
// DATABASE_URL the developer has locally - which here is a live Neon primary
// with production credentials.
//
// That is not hypothetical. Adding a transactional write to the reaper made
// `durability.test.ts` open a real transaction against the live database,
// because the test mocked `extended` and not `db`. It surfaced only as a
// "Unable to start a transaction" error, which reads like a flaky network
// problem rather than "a test is touching production".
//
// The guard converts that class of mistake from a confusing timeout into an
// immediate, explicit failure. It intercepts the PrismaClient constructor before
// any connection is opened, so nothing is sent to the database.

// `server-only` throws when imported outside a React Server Component tree,
// which is exactly what a Jest run is. Several modules under test import it, so
// it is neutralised here rather than in every individual test file.
jest.mock("server-only", () => ({}));

const REFUSAL =
  "A test tried to construct a real PrismaClient. Tests must mock " +
  '"@/lib/prisma/extended" and "@/lib/prisma/db" (both are used by the ' +
  "agent code). Check src/tests/agent/helpers/prisma-double.ts.";

jest.mock("@prisma/client", () => {
  const actual =
    jest.requireActual<typeof import("@prisma/client")>("@prisma/client");

  return {
    ...actual,
    // A plain throwing function rather than a derived class.
    //
    // Subclassing would require calling super(), and super() is what initialises
    // the Prisma engine and may open the connection this guard exists to
    // prevent. A function that throws is never a constructor, so nothing is ever
    // constructed.
    //
    // Typing is unaffected: `jest.mock` factories are not type-checked against
    // the real module, and `import { PrismaClient }` in application code still
    // resolves to the real class's type at compile time.
    PrismaClient: function GuardedPrismaClient(): never {
      throw new Error(REFUSAL);
    },
  };
});

export {};
