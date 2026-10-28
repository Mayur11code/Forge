// src/lib/ai/cache-identity.ts
//
// Cache identity primitives for the semantic cache.
//
// The semantic cache matches on embedding similarity, so the *latest* user
// question is deliberately not part of the identity: two differently worded
// questions about the same topic should share an answer. What must be identical
// is everything that changes the answer for the same topic:
//   - the conversation that led up to the question (prior turns), and
//   - the model / prompt / embedding model, which the caller passes separately.
//
// The current user turn is excluded from the history fingerprint. If it were
// included, every rephrased question would produce a new fingerprint and the
// cache could never hit — the exact bug this module exists to prevent. Including
// it would also make the fingerprint impossible to recompute on the read path,
// because a hit is (by design) a *different* question.

import { createHash } from 'crypto';

import type { ModelMessage } from 'ai';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical form used for query digests: trim, collapse whitespace, lowercase.
 * This is intentionally *not* used for embedding (semantics stay untouched);
 * it only prevents the same question with different casing/spacing from
 * producing a different stored digest.
 */
export function canonicalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Non-reversible digest of a query, safe to store in Pinecone/Redis metadata.
 *
 * Note: this is a *diagnostic/integrity* field, not a hit condition. Hits are
 * decided by embedding similarity plus compatibility/provenance checks; the
 * digest only lets us verify that the metadata and payload describe the same
 * stored query without persisting the query text itself.
 */
export function digestQuery(query: string): string {
  return sha256Hex(canonicalizeQuery(query));
}

/**
 * Index of the latest user turn, i.e. the question being answered right now.
 * Returns -1 when the conversation has no user turn.
 */
function latestUserTurnIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

/**
 * The conversation that precedes the current question. This is what the answer
 * may depend on beyond the retrieval sources.
 */
export function splitPriorHistory(messages: ModelMessage[]): ModelMessage[] {
  const index = latestUserTurnIndex(messages);
  return index === -1 ? [] : messages.slice(0, index);
}

/**
 * Stable digest of the conversation *before* the current user turn.
 *
 * `[]` (no prior history) hashes to a stable constant, so two first-turn
 * questions about the same topic share a fingerprint. Any difference in prior
 * roles, tool calls, or content produces a different digest, keeping answers
 * that depend on earlier context isolated.
 */
export function fingerprintPriorHistory(messages: ModelMessage[]): string {
  const prior = splitPriorHistory(messages).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return sha256Hex(JSON.stringify(prior));
}
