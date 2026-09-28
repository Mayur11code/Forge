export const MAX_AGENT_STEPS = 5;

/**
 * Agent session locks need to survive a Gemini request.
 * We will use this value when we build the agent mutex.
 */
export const AGENT_SESSION_LOCK_TTL_MS = 30_000;


export const AGENT_TOOL_EXECUTION_LOCK_TTL_MS = 30_000;

/**
 * How often a held lock's TTL is renewed.
 *
 * Exported for tests and diagnostics. The lock helpers derive the actual
 * interval from the TTL (a third of it) so these two cannot drift apart into
 * a heartbeat that renews too slowly to be worth having.
 */
export const AGENT_LOCK_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How long a tool execution may sit RUNNING without a heartbeat before it is
 * considered orphaned.
 *
 * A RUNNING row means a worker claimed the work and then died mid-flight. The
 * claim is durable, so nothing redelivers it: without a sweep these rows stay
 * RUNNING forever and their sessions never terminate.
 */
export const AGENT_ORPHANED_EXECUTION_AGE_MS = 10 * 60_000;

/**
 * How often a claimed execution refreshes its DB row while it runs.
 *
 * This is the durable liveness signal the reaper reads. The Redis lock
 * heartbeat keeps a concurrent worker out, but the lock is process-local
 * state that the reaper cannot see; the row is shared state it can.
 *
 * Must stay comfortably below AGENT_ORPHANED_EXECUTION_AGE_MS so a live worker
 * always looks alive.
 */
export const AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS = 30_000;


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