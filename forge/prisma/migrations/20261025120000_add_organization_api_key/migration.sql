-- Forge BYOK Phase 1 — Secure Credential Vault & Persistence
--
-- Adds OrganizationApiKey model and enums (AiProvider, CredentialPurpose, CredentialStatus)
-- to support organization-scoped AI credentials for GENERATION and EMBEDDING.
--
-- Generated offline with `prisma migrate diff --from-schema ... --to-schema prisma/schema.prisma --script`.
-- This migration is UNAPPLIED and must not be run against any database during Phase 1.

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('GEMINI');

-- CreateEnum
CREATE TYPE "CredentialPurpose" AS ENUM ('GENERATION', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING_VALIDATION', 'ACTIVE', 'INVALID', 'REVOKED');

-- CreateTable
CREATE TABLE "OrganizationApiKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL DEFAULT 'GEMINI',
    "purpose" "CredentialPurpose" NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyIv" TEXT NOT NULL,
    "keyAuthTag" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING_VALIDATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,

    CONSTRAINT "OrganizationApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationApiKey_orgId_idx" ON "OrganizationApiKey"("orgId");

-- CreateIndex
CREATE INDEX "OrganizationApiKey_status_idx" ON "OrganizationApiKey"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationApiKey_orgId_provider_purpose_key" ON "OrganizationApiKey"("orgId", "provider", "purpose");

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
