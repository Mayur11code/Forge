-- CreateTable
CREATE TABLE "RazorpayEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RazorpayEvent_pkey" PRIMARY KEY ("id")
);
