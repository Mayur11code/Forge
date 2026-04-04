/*
  Warnings:

  - A unique constraint covering the columns `[razorpayCustomerId]` on the table `Organization` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[razorpaySubscriptionId]` on the table `Organization` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "razorpayCustomerId" TEXT,
ADD COLUMN     "razorpaySubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_razorpayCustomerId_key" ON "Organization"("razorpayCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_razorpaySubscriptionId_key" ON "Organization"("razorpaySubscriptionId");
