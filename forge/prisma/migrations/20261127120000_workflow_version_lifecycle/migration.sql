-- FC-015: Immutable WorkflowVersion lifecycle & draft/published separation.
-- Preserves existing Workflow rows as unpublished drafts (publishedVersionId = NULL,
-- draftRevision = 1) and preserves existing WorkflowRun rows with nullable workflowVersionId.

-- 1. Create WorkflowVersion table
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "eventId" TEXT,
    "uiNodes" JSONB NOT NULL,
    "uiEdges" JSONB NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- 2. Extend Workflow with draftRevision and publishedVersionId
ALTER TABLE "Workflow"
  ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "publishedVersionId" TEXT;

-- 3. Extend WorkflowRun with optional workflowVersionId traceability
ALTER TABLE "WorkflowRun"
  ADD COLUMN "workflowVersionId" TEXT;

-- 4. Indexes & Uniqueness Constraints
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_versionNumber_key" ON "WorkflowVersion"("workflowId", "versionNumber");
CREATE UNIQUE INDEX "WorkflowVersion_id_workflowId_orgId_key" ON "WorkflowVersion"("id", "workflowId", "orgId");
CREATE INDEX "WorkflowVersion_workflowId_idx" ON "WorkflowVersion"("workflowId");
CREATE INDEX "WorkflowVersion_orgId_idx" ON "WorkflowVersion"("orgId");

CREATE UNIQUE INDEX "Workflow_publishedVersionId_key" ON "Workflow"("publishedVersionId");
CREATE INDEX "WorkflowRun_workflowVersionId_idx" ON "WorkflowRun"("workflowVersionId");

-- 5. Foreign Keys (including composite tenant/workflow ownership guard on publishedVersionId)
ALTER TABLE "WorkflowVersion"
  ADD CONSTRAINT "WorkflowVersion_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Workflow"
  ADD CONSTRAINT "Workflow_publishedVersionId_fkey"
  FOREIGN KEY ("publishedVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Workflow"
  ADD CONSTRAINT "Workflow_publishedVersion_ownership_fkey"
  FOREIGN KEY ("publishedVersionId", "id", "orgId") REFERENCES "WorkflowVersion"("id", "workflowId", "orgId");

ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_workflowVersionId_fkey"
  FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Database-enforced immutability for published WorkflowVersion rows
CREATE OR REPLACE FUNCTION prevent_workflow_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'WorkflowVersion rows are immutable and cannot be modified after publication';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_version_immutable
BEFORE UPDATE ON "WorkflowVersion"
FOR EACH ROW
EXECUTE FUNCTION prevent_workflow_version_mutation();
