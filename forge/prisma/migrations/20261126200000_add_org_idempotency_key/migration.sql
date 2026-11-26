-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_idempotencyKey_key" ON "Organization"("idempotencyKey");
