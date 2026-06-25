-- Documents↔Business boundary discriminator (additive follow-up to the General
-- Decision Ledger). Adds the layer/stage columns so each field decision can be
-- attributed to the Fact-Extraction (documents) or Business-Interpretation
-- (business) layer. Additive only: two nullable columns, no backfill, no change
-- to existing columns or data.

ALTER TABLE "SliceDecision" ADD COLUMN "layer" TEXT;
ALTER TABLE "SliceDecision" ADD COLUMN "stage" TEXT;
