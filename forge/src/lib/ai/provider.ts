// src/lib/ai/provider.ts
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// 1. The Factory Function
// This isolates the initialization logic and throws a hard error if the key is missing
const initGeminiSingleton = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error("CRITICAL: GEMINI_API_KEY is missing from environment variables.");
  }

  return createGoogleGenerativeAI({
    apiKey,
    // Note: If you ever need to set custom base URLs or headers for enterprise 
    // proxies later, you would add them to this config object.
  });
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