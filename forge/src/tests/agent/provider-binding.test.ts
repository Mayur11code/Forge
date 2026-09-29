// src/tests/agent/provider-binding.test.ts
//
// The agent must use the application's one validated Gemini provider.
//
// The original defect: `src/lib/ai/agent/model.ts` built its own client with the
// bare `google()` export, which reads GOOGLE_GENERATIVE_AI_API_KEY. The project
// defines GEMINI_API_KEY, and every other model consumer goes through the
// validated provider singleton. The agent therefore had no working credential
// path and bypassed the environment validation the rest of the app relies on.

jest.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";

import { agentModel } from "@/lib/ai/agent/model";
import { googleProvider } from "@/lib/ai/provider";

/**
 * The module's code with comments stripped.
 *
 * Asserting against raw source would otherwise match the very names these
 * tests forbid inside a comment explaining why they are forbidden, which is a
 * self-defeating test.
 */
const MODEL_SOURCE = stripComments(
  readFileSync("src/lib/ai/agent/model.ts", "utf8"),
);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("agent model provider binding", () => {
  it("resolves to the shared provider's model for the same model id", () => {
    const shared = googleProvider("gemini-2.5-flash");

    // Compared on identity fields rather than `toBe`, because the provider
    // factory returns a new model wrapper per call - reference equality would
    // be asserting an implementation detail of the SDK rather than the
    // property that matters, which is that both come from one configured client.
    expect(agentModel.modelId).toBe(shared.modelId);
    expect(agentModel.provider).toBe(shared.provider);
    expect(agentModel.specificationVersion).toBe(
      shared.specificationVersion,
    );
  });

  it("uses the intended model", () => {
    expect(agentModel.modelId).toBe("gemini-2.5-flash");
  });

  it("does not import the bare @ai-sdk/google provider", () => {
    // The bare export is what reads the wrong env var. It must not be
    // reachable from the agent's model module at all.
    expect(MODEL_SOURCE).not.toMatch(/@ai-sdk\/google/);
  });

  it("does not call the bare google() factory", () => {
    // Anchored so it matches the function call `google(...)` and not the
    // imported binding `googleProvider(...)`, which is the intended export.
    expect(MODEL_SOURCE).not.toMatch(/(?<![\w.])google\s*\(/);
  });

  it("does not read the environment directly", () => {
    // Credential validation has exactly one implementation, in
    // src/lib/ai/provider.ts. Re-reading process.env here would be a second one
    // that could disagree with it.
    expect(MODEL_SOURCE).not.toContain("process.env");
  });

  it("takes its provider from the shared module", () => {
    expect(MODEL_SOURCE).toContain(
      'import { googleProvider } from "@/lib/ai/provider"',
    );
  });
});

describe("the validated provider", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("throws clearly when GEMINI_API_KEY is absent", async () => {
    // The provider is a module-level singleton, so the throw happens on import.
    // Re-importing with the variable unset is the only way to observe it, and
    // the point is that the failure is LOUD rather than a silent unauthenticated
    // client that would surface much later as an opaque 500.
    delete process.env.GEMINI_API_KEY;
    delete (globalThis as { geminiGlobal?: unknown }).geminiGlobal;

    jest.resetModules();

    try {
      await expect(import("@/lib/ai/provider")).rejects.toThrow(
        /GEMINI_API_KEY/,
      );
    } finally {
      jest.resetModules();
    }
  });
});
