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
  transform: {},
}satisfies Config;

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);