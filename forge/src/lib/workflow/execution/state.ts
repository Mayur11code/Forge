// src/lib/workflow/execution/state.ts
import { db } from "@/lib/prisma/db";
import type { JsonValue } from "@/lib/workflow-types/type";

/**
 * How many times a contended merge re-reads before giving up.
 *
 * Each attempt is a fresh read of a small row plus one conditional update, and
 * contention only exists while other steps in the same run are finishing. Five
 * is far above what a run of realistic width needs - a fan-out of N parallel
 * branches finishing at once contends at most N-1 times - and the bound stops a
 * pathological caller from spinning here forever.
 */
const MAX_MERGE_ATTEMPTS = 5;

/**
 * Appends the output of a successful step to the global context.
 * Namespaced by stepId to prevent variable collisions.
 *
 * The merge is a compare-and-set loop rather than a plain read-modify-write
 * because parallel branches genuinely write this row at the same time. A
 * fan-out graph finishes its branches in whatever order the queue delivers
 * them, and two completions landing together both read the same `context`,
 * both add their own key, and both write the whole blob back - so whichever
 * write lands second erases the other's output.
 *
 * That is not a stall, which is what makes it easy to miss. The run proceeds,
 * every step reports SUCCESS, and a later step's `{{b.outputs.x}}` resolves to
 * undefined because branch `b`'s result was silently dropped. A version column
 * turns the lost update into a detected conflict: the update only applies if
 * the row has not moved since it was read, and a refused update means someone
 * else got there first, so the merge is retried against fresh state.
 *
 * `contextVersion` is incremented on every successful merge. A plain
 * `updatedAt` comparison would not do: it is also bumped by unrelated run
 * writes, and a timestamp read back within the same millisecond is not a
 * reliable change detector.
 */
export async function appendStepOutputToContext(
  runId: string,
  stepId: string,
  outputData: JsonValue,
) {
  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    const run = await db.workflowRun.findUnique({
      where: { id: runId },
      select: { context: true, contextVersion: true },
    });

    if (!run) {
      throw new Error(
        `CRITICAL: WorkflowRun ${runId} not found during context merge.`,
      );
    }

    // The cast is the JSONB read boundary: Prisma types a `Json` column as
    // `JsonValue`-compatible but widened, and `?? {}` rather than `|| {}`
    // because a falsy-but-valid JSON output (0, "", false) must be stored as
    // itself rather than silently replaced by an empty object.
    const currentContext = (run.context as Record<string, JsonValue>) ?? {};

    const nextContext = {
      ...currentContext,
      [stepId]: {
        outputs: outputData,
      },
    };

    // The claim: `contextVersion` must still be the value this merge read. If a
    // sibling branch committed in between, the predicate fails, nothing is
    // written, and the next attempt re-reads with the sibling's output intact.
    const claimed = await db.workflowRun.updateMany({
      where: { id: runId, contextVersion: run.contextVersion },
      data: {
        context: nextContext,
        contextVersion: { increment: 1 },
      },
    });

    if (claimed.count === 1) {
      return nextContext;
    }

    console.warn(
      `[CONTEXT] Merge for step ${stepId} of run ${runId} collided on attempt ${attempt}; retrying.`,
    );
  }

  throw new Error(
    `CONTEXT: Could not merge output for step ${stepId} of run ${runId} after ` +
      `${MAX_MERGE_ATTEMPTS} attempts. Concurrent writers are not settling.`,
  );
}
