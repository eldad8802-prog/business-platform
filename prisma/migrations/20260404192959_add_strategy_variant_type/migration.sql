-- AlterTable
ALTER TABLE "ReplySuggestion" ADD COLUMN     "strategyType" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "variantType" TEXT NOT NULL DEFAULT 'unknown';
