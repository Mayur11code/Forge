-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "logo" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "image" TEXT;

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "payload" JSONB,
    "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventLog_messageId_key" ON "EventLog"("messageId");

-- CreateIndex
CREATE INDEX "EventLog_status_idx" ON "EventLog"("status");

-- CreateIndex
CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");
