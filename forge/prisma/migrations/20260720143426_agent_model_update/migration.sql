/*
  Warnings:

  - You are about to drop the column `messages` on the `AgentSession` table. All the data in the column will be lost.
  - You are about to drop the column `args` on the `AgentToolExecution` table. All the data in the column will be lost.
  - You are about to drop the column `result` on the `AgentToolExecution` table. All the data in the column will be lost.
  - Added the required column `input` to the `AgentToolExecution` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL', 'SYSTEM');

-- AlterTable
ALTER TABLE "AgentSession" DROP COLUMN "messages";

-- AlterTable
ALTER TABLE "AgentToolExecution" DROP COLUMN "args",
DROP COLUMN "result",
ADD COLUMN     "input" JSONB NOT NULL;

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "toolCallId" TEXT,
    "step" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMessage_sessionId_createdAt_idx" ON "AgentMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
