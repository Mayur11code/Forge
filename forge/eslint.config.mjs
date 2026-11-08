import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Scoped override for test files: dynamic mock doubles and stubs require type flexibility
  {
    files: ["src/tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Scoped override for documented legacy worker/vector integration boundaries
  // (dynamic Prisma transactions and raw SDK payloads)
  {
    files: [
      "src/app/api/worker/embedding-worker/ew.ts",
      "src/lib/events/worker.ts",
      "src/lib/tasks/*.ts",
      "src/lib/vector/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
