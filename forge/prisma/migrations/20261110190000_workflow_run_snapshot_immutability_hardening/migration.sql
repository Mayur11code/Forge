-- 1. Table CHECK constraint: Snapshot and hash must be either both NULL or both populated
ALTER TABLE "WorkflowRun" DROP CONSTRAINT IF EXISTS chk_workflow_run_snapshot_pair;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT chk_workflow_run_snapshot_pair
CHECK (
  ("definitionSnapshot" IS NOT NULL AND "definitionHash" IS NOT NULL) OR
  ("definitionSnapshot" IS NULL AND "definitionHash" IS NULL)
);

-- 2. Trigger on INSERT: New WorkflowRun rows must be inserted with both fields populated
CREATE OR REPLACE FUNCTION check_workflow_run_snapshot_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."definitionSnapshot" IS NULL OR NEW."definitionHash" IS NULL THEN
    RAISE EXCEPTION 'New WorkflowRun must be created with both definitionSnapshot and definitionHash populated';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_run_snapshot_insert ON "WorkflowRun";
CREATE TRIGGER trg_workflow_run_snapshot_insert
BEFORE INSERT ON "WorkflowRun"
FOR EACH ROW
EXECUTE FUNCTION check_workflow_run_snapshot_insert();

-- 3. Trigger on UPDATE: Snapshot and hash cannot be populated, modified, or cleared after creation
CREATE OR REPLACE FUNCTION prevent_workflow_run_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."definitionSnapshot" IS DISTINCT FROM OLD."definitionSnapshot" THEN
    RAISE EXCEPTION 'WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation';
  END IF;

  IF NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash" THEN
    RAISE EXCEPTION 'WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_run_snapshot_immutable ON "WorkflowRun";
CREATE TRIGGER trg_workflow_run_snapshot_immutable
BEFORE UPDATE ON "WorkflowRun"
FOR EACH ROW
EXECUTE FUNCTION prevent_workflow_run_snapshot_mutation();
