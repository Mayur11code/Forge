import { googleProvider } from "@/lib/ai/provider";

/**
 * The agent model, bound to the application's single validated Gemini provider.
 *
 * The previous implementation constructed its own client with the bare
 * `google()` export from @ai-sdk/google. That export reads
 * GOOGLE_GENERATIVE_AI_API_KEY, which this project does not define, while the
 * validated provider in `src/lib/ai/provider.ts` reads GEMINI_API_KEY and
 * fails loudly when it is absent. Using the bare export meant the agent had no
 * working credential path at all, and it bypassed the environment validation
 * every other model consumer in the app already relies on.
 *
 * There is deliberately no second provider configuration here: the agent, the
 * chat route, triage, stream-audit and the vector retriever all share this
 * one singleton so credential handling has exactly one implementation.
 */
export const agentModel = googleProvider("gemini-2.5-flash");