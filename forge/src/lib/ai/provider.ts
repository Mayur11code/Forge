import "server-only";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { getAiEnv } from '@/lib/env/server';
import {
  isGeminiAuthenticationError,
  logCredentialFailover,
} from '@/lib/security/credential-rotation';

type LanguageModel = ReturnType<GoogleGenerativeAIProvider>;
type EmbeddingModel = ReturnType<GoogleGenerativeAIProvider["embeddingModel"]>;

function wrapLanguageModel(
  primaryModel: LanguageModel,
  fallbackModel?: LanguageModel | null
): LanguageModel {
  if (!fallbackModel) return primaryModel;

  const wrapped = Object.create(primaryModel) as LanguageModel;

  wrapped.doGenerate = async function (
    options: Parameters<LanguageModel["doGenerate"]>[0]
  ) {
    try {
      return await primaryModel.doGenerate(options);
    } catch (err) {
      if (isGeminiAuthenticationError(err)) {
        logCredentialFailover({
          provider: "gemini",
          subsystem: "ai",
          slot: "primary",
          operation: "doGenerate",
          errorCategory: "AUTH_FAILURE_FAILOVER",
          message: err instanceof Error ? err.message : String(err),
        });
        return await fallbackModel.doGenerate(options);
      }
      throw err;
    }
  };

  wrapped.doStream = async function (
    options: Parameters<LanguageModel["doStream"]>[0]
  ) {
    try {
      return await primaryModel.doStream(options);
    } catch (err) {
      if (isGeminiAuthenticationError(err)) {
        logCredentialFailover({
          provider: "gemini",
          subsystem: "ai",
          slot: "primary",
          operation: "doStream",
          errorCategory: "AUTH_FAILURE_FAILOVER",
          message: err instanceof Error ? err.message : String(err),
        });
        return await fallbackModel.doStream(options);
      }
      throw err;
    }
  };

  return wrapped;
}

function wrapEmbeddingModel(
  primaryEmb: EmbeddingModel,
  fallbackEmb?: EmbeddingModel | null
): EmbeddingModel {
  if (!fallbackEmb) return primaryEmb;

  const wrapped = Object.create(primaryEmb) as EmbeddingModel;

  wrapped.doEmbed = async function (
    options: Parameters<EmbeddingModel["doEmbed"]>[0]
  ) {
    try {
      return await primaryEmb.doEmbed(options);
    } catch (err) {
      if (isGeminiAuthenticationError(err)) {
        logCredentialFailover({
          provider: "gemini",
          subsystem: "vector",
          slot: "primary",
          operation: "doEmbed",
          errorCategory: "AUTH_FAILURE_FAILOVER",
          message: err instanceof Error ? err.message : String(err),
        });
        return await fallbackEmb.doEmbed(options);
      }
      throw err;
    }
  };

  return wrapped;
}

function createDualKeyProvider(
  primaryProvider: GoogleGenerativeAIProvider,
  fallbackProvider: GoogleGenerativeAIProvider | null
): GoogleGenerativeAIProvider {
  if (!fallbackProvider) {
    return primaryProvider;
  }

  const providerFn = ((
    modelId: Parameters<GoogleGenerativeAIProvider>[0]
  ) => {
    const primaryModel = primaryProvider(modelId);
    const fallbackModel = fallbackProvider(modelId);
    return wrapLanguageModel(primaryModel, fallbackModel);
  }) as GoogleGenerativeAIProvider;

  return new Proxy(providerFn, {
    get(target, prop, receiver) {
      if (prop === "languageModel") {
        return (
          modelId: Parameters<GoogleGenerativeAIProvider["languageModel"]>[0]
        ) => {
          const primaryModel = primaryProvider.languageModel(modelId);
          const fallbackModel = fallbackProvider.languageModel(modelId);
          return wrapLanguageModel(primaryModel, fallbackModel);
        };
      }
      if (prop === "embeddingModel" || prop === "textEmbeddingModel") {
        return (
          modelId: Parameters<GoogleGenerativeAIProvider["embeddingModel"]>[0]
        ) => {
          const primaryModel = primaryProvider.embeddingModel(modelId);
          const fallbackModel = fallbackProvider.embeddingModel(modelId);
          return wrapEmbeddingModel(primaryModel, fallbackModel);
        };
      }
      const val = Reflect.get(primaryProvider, prop, receiver);
      if (typeof val === "function") {
        return (val as (...args: unknown[]) => unknown).bind(primaryProvider);
      }
      return val;
    },
  });
}

// 1. The Factory Function
// This isolates the initialization logic and throws a hard error if the key is missing.
// Supports transparent dual-key failover when GEMINI_API_KEY_FALLBACK is configured.
const initGeminiSingleton = () => {
  const { GEMINI_API_KEY, GEMINI_API_KEY_FALLBACK } = getAiEnv();

  const primaryProvider = createGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    // Note: If you ever need to set custom base URLs or headers for enterprise 
    // proxies later, you would add them to this config object.
  });

  const fallbackProvider = GEMINI_API_KEY_FALLBACK
    ? createGoogleGenerativeAI({
        apiKey: GEMINI_API_KEY_FALLBACK,
      })
    : null;

  return createDualKeyProvider(primaryProvider, fallbackProvider);
};

// 2. The Global Namespace Extension
// We must tell TypeScript that we are adding custom properties to Node's global object
declare global {
  // Use 'var' here, 'let' or 'const' will not work for global namespace merging
  var geminiGlobal: undefined | ReturnType<typeof initGeminiSingleton>;
}

// 3. The Singleton Export
// If geminiGlobal exists, use it. Otherwise, run the factory to create it.
export const googleProvider = globalThis.geminiGlobal ?? initGeminiSingleton();

// 4. The Dev Environment Lock
// We only attach it to the global object in development mode.
// In production (Vercel Edge), serverless functions are ephemeral anyway, 
// so we don't want to pollute the global scope unnecessarily.
if (process.env.NODE_ENV !== 'production') {
  globalThis.geminiGlobal = googleProvider;
}
