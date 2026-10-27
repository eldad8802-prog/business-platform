-- S1-A application battery: what Production's AcquisitionConnection has that the M6-based lab table lacks, exactly as
-- M7-B/C 20261014090000 created it (the application's Prisma model reads every column). Idempotent.
ALTER TABLE "AcquisitionConnection" ADD COLUMN IF NOT EXISTS "lineLabels" JSONB;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AcquisitionConnection_line_labels') THEN
    ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_line_labels" CHECK (
      "lineLabels" IS NULL
      OR (
        "sourceKey" IN ('telephony.cloudtalk', 'telephony.voicenter')
        AND jsonb_typeof("lineLabels") = 'object'
        AND octet_length("lineLabels"::text) <= 4096
      )
    );
  END IF;
END
$$;
