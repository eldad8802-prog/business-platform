-- P2 · Business Identity + Positioning — owner statements + fact publication authority
-- (migration only)
--
-- WHAT THIS ADDS
--   1. "BusinessIdentityStatement": what the OWNER of a business has stated about who the business
--      is (description, specialization, audience, objective, tone, positioning, differentiators,
--      service area). Every row is owner-confirmed by construction; the table never holds an
--      inference.
--   2. "BusinessIdentityFactAuthority": the owner's confirmation and public-use approval of an
--      identity FACT whose canonical value stays where it is (Business.name, BusinessProfile.city /
--      openingHours, and the billing phone / email / address when the owner designates them as the
--      public contact). The value is NEVER copied: the row holds only a sha256 of the exact value it
--      was given for, so a later change of the underlying value lapses the authority by itself.
--      Fact existence ≠ permission; billing field existence ≠ permission.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   - no column on Business / BusinessProfile: those stay the FACT layer (name, category,
--     subCategory, businessModel, city, hours). A statement needs its own provenance, its own
--     public-use authority and its own history, which a profile column cannot carry.
--   - no derived-positioning table: derived signals are recomputed from evidence on read
--     (P1 offerings, demand signals, explicit owner choices) and never stored as truth.
--   - no backfill: existing businesses start with zero statements. Unknown stays unknown.
--
-- AUTHORITY CHAIN (kept as separate states, never collapsed)
--   FACT (Business/BusinessProfile/P1)  →  DERIVED (computed, MACHINE_PROPOSAL)
--   →  OWNER_CONFIRMED (a row here)  →  PUBLIC_USE_APPROVED (publicUseApproved on that row)
--   →  PUBLISHED (not built).
--   Only claim-like, text dimensions can ever be approved for public use; audience, objective,
--   tone and positioning are internal directives and are refused public-use by CHECK.
--
-- HISTORY
--   Rows are never deleted by the runtime (no DELETE grant). A change retires the old row
--   (status RETIRED + retiredAt) and inserts a new one, so "where did this come from" always
--   has an answer.
--
-- Additive only: new enum types and two new tables. Old code never reads them.

CREATE TYPE "BusinessIdentityDimension" AS ENUM (
  'DESCRIPTION',
  'SPECIALIZATION',
  'TARGET_AUDIENCE',
  'PRIMARY_OBJECTIVE',
  'SECONDARY_OBJECTIVE',
  'TONE',
  'POSITIONING',
  'DIFFERENTIATOR',
  'SERVICE_AREA'
);

CREATE TYPE "BusinessIdentitySource" AS ENUM ('OWNER_INPUT', 'OWNER_ADOPTED_SUGGESTION');

CREATE TYPE "BusinessIdentityStatus" AS ENUM ('ACTIVE', 'RETIRED');

CREATE TABLE "BusinessIdentityStatement" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "dimension" "BusinessIdentityDimension" NOT NULL,
  "code" TEXT,
  "text" TEXT,
  "source" "BusinessIdentitySource" NOT NULL,
  "sourceRef" TEXT,
  "status" "BusinessIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
  "confirmedByUserId" INTEGER,
  "publicUseApproved" BOOLEAN NOT NULL DEFAULT false,
  "publicUseApprovedAt" TIMESTAMP(3),
  "publicUseApprovedByUserId" INTEGER,
  "retiredAt" TIMESTAMP(3),
  "retiredByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessIdentityStatement_pkey" PRIMARY KEY ("id"),

  -- Coded dimensions carry a code and no text; text dimensions carry text and no code.
  CONSTRAINT "BusinessIdentityStatement_value_shape" CHECK (
    (
      "dimension" IN ('TARGET_AUDIENCE', 'PRIMARY_OBJECTIVE', 'SECONDARY_OBJECTIVE', 'TONE', 'POSITIONING')
      AND "code" IS NOT NULL AND "text" IS NULL
      AND "code" ~ '^[A-Z][A-Z_]{1,39}$'
    )
    OR (
      "dimension" IN ('DESCRIPTION', 'SPECIALIZATION', 'DIFFERENTIATOR', 'SERVICE_AREA')
      AND "text" IS NOT NULL AND "code" IS NULL
      AND char_length(btrim("text")) BETWEEN 1 AND 500
    )
  ),

  -- Public-use authority exists only for claim-like text, and always says when it was given.
  CONSTRAINT "BusinessIdentityStatement_public_use" CHECK (
    "publicUseApproved" = false
    OR (
      "dimension" IN ('DESCRIPTION', 'SPECIALIZATION', 'DIFFERENTIATOR', 'SERVICE_AREA')
      AND "publicUseApprovedAt" IS NOT NULL
    )
  ),

  CONSTRAINT "BusinessIdentityStatement_retired_shape" CHECK (
    ("status" = 'RETIRED') = ("retiredAt" IS NOT NULL)
  ),

  -- An adopted suggestion names the signal it came from.
  CONSTRAINT "BusinessIdentityStatement_provenance" CHECK (
    "source" <> 'OWNER_ADOPTED_SUGGESTION' OR "sourceRef" IS NOT NULL
  ),

  CONSTRAINT "BusinessIdentityStatement_source_ref" CHECK (
    "sourceRef" IS NULL OR char_length("sourceRef") BETWEEN 1 AND 120
  )
);

CREATE UNIQUE INDEX "BusinessIdentityStatement_id_businessId_key"
  ON "BusinessIdentityStatement"("id", "businessId");

CREATE INDEX "BusinessIdentityStatement_businessId_status_dimension_idx"
  ON "BusinessIdentityStatement"("businessId", "status", "dimension");

-- PARTIAL UNIQUE INDEXES — Prisma cannot express these, so they are raw SQL and the schema
-- carries a comment forbidding their regeneration (same hazard class as
-- PaymentAllocation_active_payment_installment_key). `prisma db push` does NOT create them;
-- the P2 DB suite replays this migration verbatim before asserting on them.
--
-- At most one ACTIVE statement per single-valued dimension. Retired rows keep their place.
CREATE UNIQUE INDEX "BusinessIdentityStatement_active_single_key"
  ON "BusinessIdentityStatement"("businessId", "dimension")
  WHERE "status" = 'ACTIVE' AND "dimension" IN ('DESCRIPTION', 'PRIMARY_OBJECTIVE', 'TONE');

-- The same code is never ACTIVE twice in one dimension.
CREATE UNIQUE INDEX "BusinessIdentityStatement_active_code_key"
  ON "BusinessIdentityStatement"("businessId", "dimension", "code")
  WHERE "status" = 'ACTIVE' AND "code" IS NOT NULL;

ALTER TABLE "BusinessIdentityStatement" ADD CONSTRAINT "BusinessIdentityStatement_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Tenant isolation: per-command policies, no FOR ALL, no DELETE policy ──────────────────────
ALTER TABLE "BusinessIdentityStatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessIdentityStatement" FORCE ROW LEVEL SECURITY;

CREATE POLICY p2_identity_statement_select ON "BusinessIdentityStatement" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p2_identity_statement_insert ON "BusinessIdentityStatement" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p2_identity_statement_update ON "BusinessIdentityStatement" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessIdentityStatement" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessIdentityStatement_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "BusinessIdentityStatement" FROM app_runtime;
  END IF;
END
$do$;

-- ── 2. Fact publication authority ───────────────────────────────────────────────────────────

CREATE TYPE "BusinessIdentityFact" AS ENUM (
  'BUSINESS_NAME',
  'CITY',
  'OPENING_HOURS',
  'PUBLIC_PHONE',
  'PUBLIC_EMAIL',
  'PUBLIC_ADDRESS'
);

CREATE TABLE "BusinessIdentityFactAuthority" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "fact" "BusinessIdentityFact" NOT NULL,
  -- The canonical column the authority is about. Fixed per fact (CHECK below); recorded so that a
  -- reader never has to guess where the value lives.
  "sourceField" TEXT NOT NULL,
  -- sha256 (hex) of the exact UTF-8 value the owner confirmed. Not the value.
  "valueHash" TEXT NOT NULL,
  "status" "BusinessIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
  "confirmedByUserId" INTEGER,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publicUseApproved" BOOLEAN NOT NULL DEFAULT false,
  "publicUseApprovedAt" TIMESTAMP(3),
  "publicUseApprovedByUserId" INTEGER,
  "retiredAt" TIMESTAMP(3),
  "retiredByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessIdentityFactAuthority_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "BusinessIdentityFactAuthority_source_field" CHECK (
    ("fact" = 'BUSINESS_NAME'  AND "sourceField" = 'Business.name')
    OR ("fact" = 'CITY'           AND "sourceField" = 'BusinessProfile.city')
    OR ("fact" = 'OPENING_HOURS'  AND "sourceField" = 'BusinessProfile.openingHours')
    OR ("fact" = 'PUBLIC_PHONE'   AND "sourceField" = 'BusinessProfile.billingPhone')
    OR ("fact" = 'PUBLIC_EMAIL'   AND "sourceField" = 'BusinessProfile.billingEmail')
    OR ("fact" = 'PUBLIC_ADDRESS' AND "sourceField" = 'BusinessProfile.billingAddress')
  ),

  CONSTRAINT "BusinessIdentityFactAuthority_value_hash" CHECK ("valueHash" ~ '^[0-9a-f]{64}$'),

  CONSTRAINT "BusinessIdentityFactAuthority_public_use" CHECK (
    "publicUseApproved" = false OR "publicUseApprovedAt" IS NOT NULL
  ),

  CONSTRAINT "BusinessIdentityFactAuthority_retired_shape" CHECK (
    ("status" = 'RETIRED') = ("retiredAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "BusinessIdentityFactAuthority_id_businessId_key"
  ON "BusinessIdentityFactAuthority"("id", "businessId");

CREATE INDEX "BusinessIdentityFactAuthority_businessId_status_idx"
  ON "BusinessIdentityFactAuthority"("businessId", "status");

-- PARTIAL UNIQUE INDEX (raw SQL, not expressible in Prisma): one ACTIVE authority per fact.
CREATE UNIQUE INDEX "BusinessIdentityFactAuthority_active_fact_key"
  ON "BusinessIdentityFactAuthority"("businessId", "fact")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "BusinessIdentityFactAuthority" ADD CONSTRAINT "BusinessIdentityFactAuthority_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessIdentityFactAuthority" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessIdentityFactAuthority" FORCE ROW LEVEL SECURITY;

CREATE POLICY p2_identity_fact_select ON "BusinessIdentityFactAuthority" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p2_identity_fact_insert ON "BusinessIdentityFactAuthority" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p2_identity_fact_update ON "BusinessIdentityFactAuthority" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessIdentityFactAuthority" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessIdentityFactAuthority_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "BusinessIdentityFactAuthority" FROM app_runtime;
  END IF;
END
$do$;
