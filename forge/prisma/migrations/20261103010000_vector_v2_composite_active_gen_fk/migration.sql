-- Migration: 20261103010000_vector_v2_composite_active_gen_fk
-- Enforces composite referential integrity: VectorEntityHead(activeGenId, id) -> VectorGeneration(id, headId)
-- Guarantees that a head's activeGenId pointer CANNOT reference a generation belonging to a different head.

-- CreateIndex: Unique index on VectorEntityHead(activeGenId, id)
CREATE UNIQUE INDEX IF NOT EXISTS "VectorEntityHead_activeGenId_id_key" ON "VectorEntityHead"("activeGenId", "id");

-- DropForeignKey: Drop legacy single-column foreign key
ALTER TABLE "VectorEntityHead" DROP CONSTRAINT IF EXISTS "VectorEntityHead_activeGenId_fkey";

-- Pre-migration data integrity check:
-- Ensure that no existing VectorEntityHead has an activeGenId that points to a VectorGeneration belonging to a different head.
DO $$
DECLARE
  v_invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_invalid_count
  FROM "VectorEntityHead" h
  WHERE h."activeGenId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "VectorGeneration" g
      WHERE g.id = h."activeGenId"
        AND g."headId" = h.id
    );

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % VectorEntityHead row(s) contain activeGenId referencing generations of another head or nonexistent generations. Historical data must be audited.', v_invalid_count;
  END IF;
END $$;

-- AddForeignKey: Composite referential integrity
-- VectorEntityHead(activeGenId, id) -> VectorGeneration(id, headId)
-- Safe NULL behavior: In PostgreSQL MATCH SIMPLE, when activeGenId is NULL, the FK check succeeds.
-- ON DELETE RESTRICT: Prevents deleting an active generation without first clearing activeGenId on the head.
ALTER TABLE "VectorEntityHead" 
  ADD CONSTRAINT "VectorEntityHead_activeGenId_id_fkey" 
  FOREIGN KEY ("activeGenId", "id") 
  REFERENCES "VectorGeneration"("id", "headId") 
  ON DELETE RESTRICT 
  ON UPDATE CASCADE;
