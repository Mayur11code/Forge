// jest.live.config.ts
//
// Jest config for the live-model acceptance project.
//
// Difference from jest.config.ts: this project runs `*.live.test.ts` suites
// that make a REAL call to the configured Gemini model. The default config
// ignores that pattern, so `npm test` never spends model quota and never needs
// network access.
//
// Everything else mirrors the default config, and that includes keeping the
// PrismaClient refusal from `jest.setup-db-guard.ts`: a live-model suite proves
// a *parse* boundary, not a persistence path, so a real database connection
// would be a defect rather than evidence. A suite that needs a database belongs
// to jest.realdb.config.ts instead.
//
// Run a live-model acceptance suite with:
//   npx jest --config jest.live.config.ts src/tests/agent/generate-workflow.live.test.ts
//
// Convention: live suites are named `*.live.test.ts`. They are never part of the
// default run, because each execution costs quota and can only be repeated while
// credentials and quota are available.

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
  setupFilesAfterEnv: ["<rootDir>/jest.setup-db-guard.ts"],
  testMatch: ["**/*.live.test.ts"],
  transform: {},
  // A live model call holds network handles open after the assertions finish,
  // so the process would otherwise wait on them. These are one-shot acceptance
  // runs: exit once results are reported.
  forceExit: true,
} satisfies Config;

export default createJestConfig(config);
