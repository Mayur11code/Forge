// src/lib/security/public-error.ts
//
// S5 (strengthened) — a disclosure-safe projection of an internal error message
// onto what a client may see.
//
// The earlier fix returned the first line of the persisted `error.message`.
// "First line" is a formatting rule, not a safety rule: a single-line error can
// still carry a filesystem path, a Postgres constraint name, a connection
// string, or an unrestricted provider response. Truncating at a newline happens
// to hide a stack, but it does not establish that what remains is safe.
//
// The correct shape is an ALLOWLIST. Only errors the application itself authors
// as user-facing are passed through, matched by stable, non-sensitive patterns.
// Everything else — database errors, filesystem errors, provider/SDK errors,
// anything stack-bearing or unrecognised — collapses to one generic message.
//
// Useful diagnostics are preserved server-side: callers keep logging the raw
// error; only the value handed to a client is sanitised here.

/** The single fallback shown for any error that is not on the allowlist. */
export const GENERIC_PUBLIC_ERROR = "The operation could not be completed.";

/**
 * Patterns for errors this application authors as safe to show a user.
 *
 * Each entry is a prefix/exact match on a message the codebase itself produces.
 * They are deliberately narrow and contain no interpolated runtime data, so a
 * match cannot smuggle a path or identifier through it.
 */
const SAFE_PUBLIC_ERROR_PATTERNS: RegExp[] = [
  // Tool input validation (src/lib/ai/agent/tools/**).
  /^Tool input cannot be null\.$/,
  /^Tool input is invalid\b/,
  /^Missing required field\b/,
  /^Unknown tool:\s/,
  // Criticality decision validation surfaced to the reviewing user.
  /^The criticality decisions are invalid\.$/,
  // Workflow trigger not-found. The interpolated id is caller-supplied, so it
  // carries no server-side information.
  /^Cannot start workflow: .+ not found\.$/,
];

function isSafePublicError(firstLine: string): boolean {
  return SAFE_PUBLIC_ERROR_PATTERNS.some((pattern) => pattern.test(firstLine));
}

/**
 * Reduce an arbitrary persisted/passthrough error to a client-safe string.
 *
 * - `null`/empty stays `null`.
 * - Only the first line is ever considered (a stack never survives).
 * - The first line is returned ONLY if it matches the allowlist; otherwise the
 *   generic fallback is returned.
 *
 * Never returns a multi-line value, a path, or an unrecognised internal string.
 */
export function toPublicError(error: string | null | undefined): string | null {
  if (!error) return null;

  const firstLine = error.split("\n", 1)[0].trim();
  if (firstLine.length === 0) return null;

  return isSafePublicError(firstLine) ? firstLine : GENERIC_PUBLIC_ERROR;
}
