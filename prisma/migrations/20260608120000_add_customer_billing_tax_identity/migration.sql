-- CreateEnum
CREATE TYPE "CustomerTaxIdType" AS ENUM ('AUTHORIZED_DEALER', 'EXEMPT_DEALER', 'LTD_COMPANY', 'PRIVATE_ID', 'OTHER');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "taxIdType" "CustomerTaxIdType";
