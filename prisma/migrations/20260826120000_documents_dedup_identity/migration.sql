-- Documents duplicate-defense identity (Integrity Blueprint §6, Wave 1B).
-- Expand-only: three nullable columns + one index. No backfill here — existing
-- rows are hashed by scripts/documents/backfill-content-hash.ts (manual, gated).

ALTER TABLE "Document" ADD COLUMN "contentHashSha256" TEXT;
ALTER TABLE "Document" ADD COLUMN "originalFilename" TEXT;
ALTER TABLE "Document" ADD COLUMN "sizeBytes" INTEGER;

CREATE INDEX "Document_businessId_contentHashSha256_idx"
  ON "Document"("businessId", "contentHashSha256");
