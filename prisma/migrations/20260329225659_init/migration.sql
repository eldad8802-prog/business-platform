-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" SERIAL NOT NULL,
    "businessName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);
