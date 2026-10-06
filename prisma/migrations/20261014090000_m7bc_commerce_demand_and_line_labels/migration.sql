-- M7-B / M7-C · store-order demand signals and owner line labels (decision record:
-- docs/business-intake-m7-decision-v1.md §11; release package docs/business-intake-m7bc-release.md §3).
--
-- WHAT THIS ADDS
--   OfferingDemandSource 'COMMERCE'                 a new demand-signal source: a line of an online-store order
--   OfferingDemandSignal."commerceOrderLineId"     which order line is the evidence (composite tenant FK)
--   CommerceOrderLine ("id", "businessId") UNIQUE  the target of that composite FK
--   OfferingDemandSignal_identity                  re-created wider: PURCHASE may come from SALE (as before) or
--                                                  COMMERCE (new); every existing row stays valid
--   AcquisitionConnection."lineLabels"             the owner's names for the business's own phone lines, on a
--                                                  TELEPHONY connection only (CHECK)
--
-- INVARIANTS
--   * A COMMERCE signal is a PRODUCT purchase pointing at exactly one store order line and no sale line /
--     appointment; a SALE / APPOINTMENT signal never points at a store line.
--   * Tenant: the new FK is composite (businessId, id) — a signal can only point at a line of its own business.
--     OfferingDemandSignal and AcquisitionConnection keep their existing FORCE RLS policies and grants (the new
--     columns are covered by the table-level grants already in place; nothing is widened for the runtime).
--   * No PII: a line label is the owner's business wording for their own number; nothing about a caller.
--   * The enum value is compared as text in the CHECK, so it is usable inside this same transaction.
--
-- EXPAND-ONLY for data: no existing row changes. One CHECK is re-created wider (same branches + the new one).

-- ── 0. Preconditions ───────────────────────────────────────────────────────────

DO $pre$
BEGIN
  IF to_regclass('public."CommerceOrderLine"') IS NULL THEN
    RAISE EXCEPTION 'requires M7-A (CommerceOrderLine is missing)';
  END IF;
  IF to_regclass('public."OfferingDemandSignal"') IS NULL THEN
    RAISE EXCEPTION 'requires P1 (OfferingDemandSignal is missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfferingDemandSignal_identity') THEN
    RAISE EXCEPTION 'requires the P1 OfferingDemandSignal_identity CHECK';
  END IF;
END
$pre$;

-- ── 1. Demand: a store order line as PURCHASE evidence ───────────────────────────

ALTER TYPE "OfferingDemandSource" ADD VALUE IF NOT EXISTS 'COMMERCE';

CREATE UNIQUE INDEX "CommerceOrderLine_id_businessId_key" ON "CommerceOrderLine"("id", "businessId");

ALTER TABLE "OfferingDemandSignal" ADD COLUMN "commerceOrderLineId" INTEGER;

ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_commerceOrderLineId_businessId_fkey"
  FOREIGN KEY ("commerceOrderLineId", "businessId") REFERENCES "CommerceOrderLine"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OfferingDemandSignal_businessId_commerceOrderLineId_idx"
  ON "OfferingDemandSignal"("businessId", "commerceOrderLineId");

ALTER TABLE "OfferingDemandSignal" DROP CONSTRAINT "OfferingDemandSignal_identity";
ALTER TABLE "OfferingDemandSignal" ADD CONSTRAINT "OfferingDemandSignal_identity" CHECK (
  (
    "signalType" = 'BOOKING'
    AND "source"::text = 'APPOINTMENT'
    AND "appointmentId" IS NOT NULL
    AND "saleLineId" IS NULL
    AND "commerceOrderLineId" IS NULL
    AND "offeringKind" = 'SERVICE'
  )
  OR (
    "signalType" = 'PURCHASE'
    AND "source"::text = 'SALE'
    AND "saleLineId" IS NOT NULL
    AND "appointmentId" IS NULL
    AND "commerceOrderLineId" IS NULL
    AND "offeringKind" = 'PRODUCT'
  )
  OR (
    "signalType" = 'PURCHASE'
    AND "source"::text = 'COMMERCE'
    AND "commerceOrderLineId" IS NOT NULL
    AND "saleLineId" IS NULL
    AND "appointmentId" IS NULL
    AND "offeringKind" = 'PRODUCT'
  )
  OR (
    "signalType" IN ('PRICE', 'AVAILABILITY')
    AND "appointmentId" IS NULL
    AND "saleLineId" IS NULL
    AND "commerceOrderLineId" IS NULL
  )
);

-- ── 2. Owner line labels on telephony connections ──────────────────────────────

ALTER TABLE "AcquisitionConnection" ADD COLUMN "lineLabels" JSONB;

ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_line_labels" CHECK (
  "lineLabels" IS NULL
  OR (
    "sourceKey" IN ('telephony.cloudtalk', 'telephony.voicenter')
    AND jsonb_typeof("lineLabels") = 'object'
    AND octet_length("lineLabels"::text) <= 4096
  )
);
