// src/lib/vector/provenance.ts
//
// Source provenance for cached chat answers.
//
// A cached answer is only reusable while the records that produced it are still
// present, still belong to the asking organization, and still hold the same
// content. This module is the single place that decides what a "source" is and
// what its freshness version is, so the write path and the read path cannot
// disagree about either.
//
// Source types are limited to what the embedding worker actually indexes:
//   - `task`       — a vector built from the Task row itself
//   - `attachment` — a "document" vector built from an Attachment row; its
//                    text also embeds the parent task's title and ids, so the
//                    parent task is recorded as a separate source
//
// Authorization note: Forge grants access to every resource in an organization
// through membership in that organization; there is no per-project or
// per-resource ACL (see `getOrgAccess`). Scoping every lookup by
// `project.orgId` / `task.project.orgId` therefore *is* the authoritative
// authorization boundary for these sources. A task that no longer exists, was
// moved to another project, or whose content changed is detected by the
// version below; a user who lost organization membership is rejected by the
// membership check in `checkSemanticCache`.

import { db } from '@/lib/prisma/db';

import type { SemanticSourceType } from './schema';

export interface SourceRef {
  type: SemanticSourceType;
  id: string;
}

export interface SourceProvenance extends SourceRef {
  /**
   * Opaque freshness token. Compared for equality only; never parsed by
   * callers. Built from fields that are actually maintained: `Task.updatedAt`
   * is bumped by every Prisma update, and attachments are immutable (they are
   * replaced, never edited), so `createdAt` + `size` + parent-task identity
   * fully describe an attachment chunk's inputs.
   */
  version: string;
}

export interface ProvenanceResolution {
  /**
   * False when at least one referenced source could not be loaded inside the
   * organization. Callers must treat this as unsafe and reject the candidate.
   */
  complete: boolean;
  sources: SourceProvenance[];
}

/**
 * Canonical, order-insensitive representation of a source set: deduplicated
 * `type, id, version` triples, sorted. Two provenance sets are interchangeable
 * only when these arrays are identical.
 */
export function normalizeSourceSet(
  sources: SourceProvenance[]
): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    seen.add(`${source.type}\u0000${source.id}\u0000${source.version}`);
  }
  return [...seen].sort();
}

/**
 * True when both sets describe exactly the same sources at exactly the same
 * versions. Order and duplicates are irrelevant; adding, removing, replacing,
 * or re-versioning any source makes the sets unequal.
 */
export function sourceSetsEqual(
  a: SourceProvenance[],
  b: SourceProvenance[]
): boolean {
  const left = normalizeSourceSet(a);
  const right = normalizeSourceSet(b);
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

type TaskVersionRow = {
  id: string;
  updatedAt: Date;
  projectId: string;
};

type AttachmentVersionRow = {
  id: string;
  taskId: string;
  createdAt: Date;
  size: number;
  task: { updatedAt: Date };
};

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

export function taskSourceVersion(task: {
  updatedAt: Date;
  projectId: string;
}): string {
  return `task:${toIso(task.updatedAt)}:${task.projectId}`;
}

export function attachmentSourceVersion(attachment: {
  createdAt: Date;
  size: number;
  taskId: string;
  task: { updatedAt: Date };
}): string {
  return [
    'attachment',
    toIso(attachment.createdAt),
    attachment.size,
    attachment.taskId,
    toIso(attachment.task.updatedAt),
  ].join(':');
}

function dedupe(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

/**
 * Loads the current version of every referenced source, scoped to `orgId`.
 *
 * One batched query per source type. `complete` is false when any requested
 * source is missing, out of scope, or of an unknown type — the caller must not
 * reuse a cached answer in that case.
 */
export async function resolveSourceProvenance(
  orgId: string,
  refs: SourceRef[]
): Promise<ProvenanceResolution> {
  const unique = dedupe(refs);
  const taskIds = unique.filter((ref) => ref.type === 'task').map((ref) => ref.id);
  const attachmentIds = unique
    .filter((ref) => ref.type === 'attachment')
    .map((ref) => ref.id);

  const [tasks, attachments] = await Promise.all([
    taskIds.length > 0
      ? (db.task.findMany({
          where: { id: { in: taskIds }, project: { orgId } },
          select: { id: true, updatedAt: true, projectId: true },
        }) as unknown as Promise<TaskVersionRow[]>)
      : Promise.resolve<TaskVersionRow[]>([]),
    attachmentIds.length > 0
      ? (db.attachment.findMany({
          where: { id: { in: attachmentIds }, task: { project: { orgId } } },
          select: {
            id: true,
            taskId: true,
            createdAt: true,
            size: true,
            task: { select: { updatedAt: true } },
          },
        }) as unknown as Promise<AttachmentVersionRow[]>)
      : Promise.resolve<AttachmentVersionRow[]>([]),
  ]);

  const versions = new Map<string, string>();
  for (const task of tasks) {
    versions.set(`task:${task.id}`, taskSourceVersion(task));
  }
  for (const attachment of attachments) {
    versions.set(
      `attachment:${attachment.id}`,
      attachmentSourceVersion(attachment)
    );
  }

  const sources: SourceProvenance[] = [];
  let complete = true;
  for (const ref of unique) {
    const version = versions.get(`${ref.type}:${ref.id}`);
    if (version === undefined) {
      complete = false;
      continue;
    }
    sources.push({ type: ref.type, id: ref.id, version });
  }

  return { complete, sources };
}
