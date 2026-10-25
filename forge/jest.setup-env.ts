// jest.setup-env.ts
//
// Gives the test run a placeholder credential when the developer has not
// provided one, so `npm test` is green on a fresh clone with no `.env`.
//
// Why this exists
// ---------------
// `src/lib/ai/provider.ts` exports its singleton eagerly:
//
//     export const googleProvider = globalThis.geminiGlobal ?? initGeminiSingleton();
//
// and `initGeminiSingleton` throws when `GEMINI_API_KEY` is absent. That
// fail-fast is correct for the application - a server that boots without
// credentials should stop immediately rather than hand out unauthenticated
// 500s later. But it also means the throw happens on *import*, so any test that
// transitively reaches the provider cannot run without a key.
//
// It surfaced in CI: a GitHub runner has no `.env`, `provider-binding.test.ts`
// failed at module load, and 0 of its assertions ever executed. The same failure
// would hit anyone cloning the repository and running `npm test`.
//
// This is the second guard of that shape in this repo, and for the same reason
// as `jest.setup-db-guard.ts`: the suite must not depend on the developer's
// `.env`. That guard exists because `next/jest` loads the real `.env`, which
// used to point tests at a live database. This one exists because `next/jest`
// loads the real `.env`, which used to mean a credential that CI does not have.
//
// Why a placeholder is honest here
// --------------------------------
// No test in this suite makes a network call. `provider-binding.test.ts` - the
// only test that imports the provider - calls `googleProvider(id)` and compares
// `modelId`, `provider` and `specificationVersion`, all of which are local
// properties of a model descriptor. Constructing a client never presents a
// credential to Google, so there is nothing for this value to be wrong *about*.
//
// The suite does not need a credential; it only needs one to exist so the
// module-level singleton can be constructed. Supplying one that cannot work is
// more truthful than failing, and is safer than the alternative: if a future
// test ever did make a real call, a placeholder would be rejected by the API
// instead of silently spending a real quota.
//
// `??=` - never replaces a real key. `next/jest` loads `.env` before setup files
// run, so a developer with a genuine key keeps using it, and the test in
// `provider-binding.test.ts` that deliberately deletes the variable and asserts
// the throw is unaffected: it mutates `process.env` inside its own test body,
// after this has already run.
process.env.GEMINI_API_KEY ??= "jest-placeholder-not-a-real-key";
process.env.PINECONE_API_KEY_DEV ??= "jest-placeholder-pinecone-dev-key";
process.env.PINECONE_INDEX_DEV ??= "jest-placeholder-pinecone-dev-index";
process.env.RAZORPAY_PLAN_ID ??= "plan_test_active";

// `jest-environment-jsdom` does not expose `TextEncoder`/`TextDecoder`, but the
// real modules the application imports do reach them - `@prisma/client` pulls in
// `cuid2`, which hashes with `@noble/hashes` and calls `new TextEncoder()` at
// module load. Node provides both globals, so they are copied across only when
// the environment is missing them (`??=` never replaces a real one, and the node
// test environment already has both).
//
// Without this, any jsdom test that transitively imports a module depending on
// `@prisma/client` fails at import time with `ReferenceError: TextEncoder is not
// defined`, before a single assertion runs. Assignment 37.10's proposal-graph
// preview is the first client component to import the shared `ActionNode`, which
// reads `StepExecutionStatus` from `@prisma/client`.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "util";

const polyfillable = globalThis as unknown as {
  TextEncoder?: typeof NodeTextEncoder;
  TextDecoder?: typeof NodeTextDecoder;
};

polyfillable.TextEncoder ??= NodeTextEncoder;
polyfillable.TextDecoder ??= NodeTextDecoder;