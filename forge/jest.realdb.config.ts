// jest.realdb.config.ts
//
// Jest config for the real-database acceptance project.
//
// Difference from jest.config.ts: `setupFilesAfterEnv` points at
// jest.setup-realdb.ts, which does NOT install the PrismaClient refusal from
// jest.setup-db-guard.ts. That refusal is what stops every ordinary test from
// opening a real connection; the real-DB acceptance test exists precisely to
// open one, against the database named by DATABASE_URL.
//
// Everything else mirrors the default config so the two projects resolve
// modules and load `.env` identically.
//
// Run a real-DB acceptance suite with:
//   npx jest --config jest.realdb.config.ts src/tests/security/i6-cross-tenant.realdb.test.ts
//
// Convention: real-DB suites are named `*.realdb.test.ts`. The default
// jest.config.ts ignores that pattern so the guard-protected run never tries to
// execute them.
//
// WARNING: tests run under this config may write to the configured database.
// They are responsible for creating and removing their own fixtures.

import nextJest from "next/jest.js";
import type { Config } from "jest";

const createJestConfig = nextJest({
  dir: "./",
});

const config = {
  coverageProvider: "v8",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  setupFiles: ["<rootDir>/jest.setup-env.ts"],
  // Intentionally NOT jest.setup-db-guard.ts — see the header.
  setupFilesAfterEnv: ["<rootDir>/jest.setup-realdb.ts"],
  transform: {},
  // `src/lib/prisma/db.ts` builds a module-level `pg.Pool`, which `$disconnect()`
  // does not close, so the process would otherwise hang on an open handle after
  // the assertions finish. This project is for one-shot acceptance runs, so exit
  // once results are reported.
  forceExit: true,
} satisfies Config;

export default createJestConfig(config);
