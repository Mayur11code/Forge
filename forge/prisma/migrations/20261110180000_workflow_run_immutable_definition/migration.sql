-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "definitionSnapshot" JSONB;
ALTER TABLE "WorkflowRun" ADD COLUMN "definitionHash" TEXT;

-- Immutability trigger for WorkflowRun definitionSnapshot and definitionHash
CREATE OR REPLACE FUNCTION prevent_workflow_run_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."definitionSnapshot" IS NOT NULL AND NEW."definitionSnapshot" IS DISTINCT FROM OLD."definitionSnapshot" THEN
    RAISE EXCEPTION 'WorkflowRun definitionSnapshot is immutable and cannot be modified once set';
  END IF;
  IF OLD."definitionHash" IS NOT NULL AND NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash" THEN
    RAISE EXCEPTION 'WorkflowRun definitionHash is immutable and cannot be modified once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_run_snapshot_immutable ON "WorkflowRun";
CREATE TRIGGER trg_workflow_run_snapshot_immutable
BEFORE UPDATE ON "WorkflowRun"
FOR EACH ROW
EXECUTE FUNCTION prevent_workflow_run_snapshot_mutation();
