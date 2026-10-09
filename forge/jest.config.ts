// jest.config.ts
import nextJest from 'next/jest.js';
import type { Config } from 'jest';

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your tests
  dir: './',
});

// Add any custom config to be passed to Jest
const config = {
  coverageProvider: 'v8',
  testEnvironment: 'node', // Use 'node' since we are testing backend vector infrastructure
  moduleNameMapper: {
    // Handle module aliases (matching your tsconfig.json paths)
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Must run before the test file's own imports, because the provider singleton
  // in src/lib/ai/provider.ts is constructed at module load and throws without
  // GEMINI_API_KEY. Runs earliest of all setup phases, and `next/jest` has
  // already loaded `.env` by now, so this fills the gap rather than overriding.
  setupFiles: ['<rootDir>/jest.setup-env.ts'],
  // Refuses to let any test open a real database connection. See the file for
  // why: agent code uses two prisma modules, and mocking only one of them used
  // to point tests at the live database via the developer's .env.
  setupFilesAfterEnv: ['<rootDir>/jest.setup-db-guard.ts'],
  transform: {},
}satisfies Config;

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);