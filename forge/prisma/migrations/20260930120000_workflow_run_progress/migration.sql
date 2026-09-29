-- Workflow run progress tracking and context concurrency control.
--
-- Two additive columns on "WorkflowRun", both defaulting so that every existing
-- row is valid immediately and the migration can run online.
--
-- 1. contextVersion
--
--    Guards the per-step context merge. Steps in a fan-out branch finish at the
--    same time and each rewrites the entire `context` document, so two
--    concurrent completions both read the same blob and the second write drops
--    the first branch's output. The run still reports success - it just loses
--    data that a later step's {{...}} pointer was supposed to resolve.
--
--    DEFAULT 0 NOT NULL is deliberate: backfilling is a table rewrite on
--    Postgres, and every existing row is already at version 0 by definition
--    because the column did not exist. Same reason it is not a nullable column
--    with a null-is-zero read path - a null here would silently re-enable the
--    lost update for exactly the rows least likely to be re-run.
--
-- 2. lastAdvancedAt
--
--    Distinguishes a stuck run from a slow one. `startedAt` on a non-terminal
--    row cannot tell those apart: a legitimately long workflow and one whose
--    process died an hour ago look identical. NULL for existing rows, because
--    inventing "now" for historical runs would make the stale-run sweeper treat
--    every open run as freshly touched and never sweep them.
--
--    The partial index below covers the sweeper's main disjunct: non-terminal
--    runs that have advanced, ordered by recency. Terminal runs are never swept,
--    so indexing them would only make the index bigger. It deliberately does not
--    cover the sweeper's second disjunct (runs with a NULL lastAdvancedAt, which
--    fall back to startedAt for their age): that is the small minority of runs
--    that never advanced at all, and including NULLs would put every such row
--    into the index for the benefit of a case that resolves against startedAt
--    anyway.
--
-- The index is deliberately NOT concurrent. It is built on an empty result set
-- (every pre-existing row has NULL lastAdvancedAt and therefore does not match
-- the partial predicate), so the blocking cost is trivial and CONCURRENTLY would
-- buy nothing while requiring a stricter transaction context.

ALTER TABLE "WorkflowRun"
  ADD COLUMN "contextVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAdvancedAt" TIMESTAMP(3);

CREATE INDEX "WorkflowRun_stale_sweep_idx"
  ON "WorkflowRun" ("lastAdvancedAt")
  WHERE "lastAdvancedAt" IS NOT NULL
    AND "completedAt" IS NULL;
