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
 * How long a session may sit RUNNING without advancing before recovery considers
 * re-driving it.
 *
 * Deliberately NOT a liveness signal on its own. `AgentSession.updatedAt` moves
 * only when a step is claimed, so a healthy worker in the middle of a long Gemini
 * turn looks exactly as old as a dead one. The value is therefore only a cheap
 * pre-filter that bounds how much of the table a pass inspects; the session lock
 * is the authoritative "nobody is working on this right now" check, and the
 * re-read under that lock is the authoritative staleness check. See
 * `redriveStalledSessions`.
 *
 * Set to the same order as AGENT_ORPHANED_EXECUTION_AGE_MS so the two recovery
 * duties agree on how long "long" is, and comfortably above AGENT_SESSION_LOCK_TTL_MS
 * so a worker that died holding a lock is not mistaken for one that is mid-turn.
 */
export const AGENT_STALLED_SESSION_AGE_MS = 10 * 60_000;

/**
 * How many delivery attempts a single stalled-session re-drive gets before the
 * session is given up on.
 *
 * Counts total deliveries of the re-drive event, so one initial publish plus two
 * re-arms. Bounded on purpose: an event that is published but never acted on -
 * a delivery the consumer refused because it lost a race for the session lock,
 * say - would otherwise be retried every maintenance tick forever, which is an
 * unbounded loop dressed up as a recovery mechanism.
 *
 * Exhausting it is a terminal outcome rather than another retry. A session that
 * cannot make progress after three attempts is broken in a way re-driving cannot
 * fix, and leaving it RUNNING means the user watches a spinner that never
 * resolves. It is failed with an explicit reason instead, matching how the
 * execution reaper terminates rather than spins.
 */
export const AGENT_STALLED_SESSION_MAX_REDRIVES = 3;

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
 * How long a proposal may sit in PENDING_CONFIRMATION before the system gives
 * up on the human and transitions it to EXPIRED.
 *
 * Default is 15 minutes. That is long enough to notice a prompt and come back,
 * short enough that an abandoned session does not sit pinned to a locked
 * execution slot for hours. The value is deliberately read from the environment
 * here, in one place, rather than being written into route logic where two
 * different callers could quietly disagree about how long approval lasts.
 *
 * Not derived from `updatedAt` on the execution row: any incidental write would
 * slide the deadline forward and defeat the timeout entirely. The deadline is
 * persisted as an explicit `expiresAt` at proposal time instead.
 */
export function getAgentApprovalTimeoutMs(): number {
  const raw = process.env.AGENT_APPROVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_AGENT_APPROVAL_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid AGENT_APPROVAL_TIMEOUT_MS: ${JSON.stringify(raw)}. Must be a positive number of milliseconds.`,
    );
  }
  return parsed;
}

export const DEFAULT_AGENT_APPROVAL_TIMEOUT_MS = 15 * 60_000;

/**
 * Maximum rows a single maintenance pass will touch, per operation.
 *
 * Every maintenance query is bounded and ordered so a pass is cheap, repeatable
 * and safe to run concurrently with itself. Anything still pending simply gets
 * picked up on the next tick, which is why the interval is set well below the
 * staleness thresholds above.
 */
export const AGENT_MAINTENANCE_BATCH_SIZE = 100;

/**
 * Backoff schedule for outbox dispatch failures, in attempts (1-indexed).
 * Attempts beyond the end reuse the last value, so a poison event keeps
 * retrying slowly instead of either spinning hot or being dropped.
 */
export const AGENT_OUTBOX_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

/**
 * How long a claimed outbox row is invisible to other dispatch passes.
 *
 * This is a lease, not a delay. Claiming pushes `availableAt` forward by this
 * amount, so an overlapping maintenance tick cannot claim the same row while
 * the first is still publishing it. If the process dies mid-publish the row
 * simply becomes claimable again when the lease expires - the intent is never
 * lost, it is only re-attempted, and a duplicate is safe because the consumers
 * are compare-and-set guarded.
 *
 * Set comfortably above a normal publish round trip and comfortably below the
 * five-minute maintenance interval, so a stuck publish is retried long before
 * the next tick and an ordinary one never straddles a tick.
 */
export const AGENT_OUTBOX_CLAIM_LEASE_MS = 30_000;

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