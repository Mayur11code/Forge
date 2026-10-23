// src/lib/prisma/transaction-options.ts
//
// Interactive-transaction options for the agent path.
//
// Prisma's defaults for an interactive transaction are `maxWait: 2000` (how
// long it waits for a pooled connection) and `timeout: 5000` (how long the
// transaction body may run before the commit is refused). BOTH are tuned for a
// LOCAL database.
//
// Against a remote server that is a different machine, reached over the public
// internet, the same transaction costs far more than 5 seconds:
//
//   - a COLD connection handshake is seconds, not milliseconds;
//   - every statement inside the transaction is a separate network round trip;
//   - the agent's transactions are multi-statement by design, because the tool
//     outcome, the transcript entry, the proposal park, the outbox intent and
//     the session wait have to commit together or not at all.
//
// When the body overruns the ceiling Prisma refuses the COMMIT with P2028
// ("A commit cannot be executed on an expired transaction"). Nothing about the
// agent's logic caused it: the work was correct and the database rejected the
// COMMIT because the clock ran out. That failure is invisible to the unit
// tests, because the prisma double resolves instantly and the default
// timeout is therefore unreachable in every mocked suite. It only appears
// against a real database over a real network.
//
// The numbers below are a BOUND, not a target. The transaction bodies are
// fixed, finite sequences of statements with no unbounded loops and no
// external I/O inside them, so a generous ceiling only converts "the network
// was slow" into "the transaction waited" and never into "the transaction
// hung". `maxWait` is raised for the same reason: the agent worker, the
// maintenance worker and the request path share one pool, so acquiring a
// connection can legitimately take longer than the default when that pool is
// busy.
export const AGENT_TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 30_000,
} as const;

export type AgentTransactionOptions = typeof AGENT_TRANSACTION_OPTIONS;
