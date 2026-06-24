export const MAX_AGENT_STEPS = 5;

/**
 * Agent session locks need to survive a Gemini request.
 * We will use this value when we build the agent mutex.
 */
export const AGENT_SESSION_LOCK_TTL_MS = 30_000;

/**
 * Builds an absolute URL only when we need one later.
 * Keep APP_URL server-only — never use NEXT_PUBLIC_APP_URL for backend URLs.
 */
export function getAppUrl(path: string): string {
  const appUrl = process.env.APP_URL;

  if (!appUrl) {
    throw new Error("Missing APP_URL environment variable.");
  }

  return new URL(path, appUrl).toString();
}