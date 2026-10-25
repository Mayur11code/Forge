// src/lib/pusher/workflow-channel.ts
//
// Pure channel naming and extraction for private workflow run live streams.

export const WORKFLOW_CHANNEL_PREFIX = "private-workflow-";

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the private workflow run channel name from a persisted workflow run id.
 */
export function workflowChannelName(runId: string): string {
  if (typeof runId !== "string") {
    throw new Error("Workflow channel requires a string run id.");
  }

  const id = runId.trim();

  if (!id || id !== runId) {
    throw new Error(
      "Workflow channel requires a non-empty run id without surrounding whitespace.",
    );
  }

  return `${WORKFLOW_CHANNEL_PREFIX}${id}`;
}

/**
 * Extract the workflow run id from a private workflow channel name.
 *
 * Returns null for anything that is not exactly `private-workflow-<runId>`.
 */
export function extractWorkflowRunId(channelName: string): string | null {
  if (typeof channelName !== "string") {
    return null;
  }

  if (!channelName.startsWith(WORKFLOW_CHANNEL_PREFIX)) {
    return null;
  }

  const runId = channelName.slice(WORKFLOW_CHANNEL_PREFIX.length);

  if (!RUN_ID_PATTERN.test(runId)) {
    return null;
  }

  return runId;
}
