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