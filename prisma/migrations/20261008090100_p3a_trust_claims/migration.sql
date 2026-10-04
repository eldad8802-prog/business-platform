-- P3-A · Owner-governed Trust + Conversion intelligence (migration only)
--
-- Depends on 20261008090000_p3a_identity_enum_values (the labels named below).
--
-- WHAT THIS ADDS
--   1. "BusinessTrustClaim": a statement Dubiz may one day make about a business — founded year,
--      customers served, a licence, a certification, an authorised dealership, a guarantee —
--      exactly as the OWNER confirmed it. It is the only P3 object that can ever carry public-use
--      authority. Evidence and signals are computed on read and are never stored, here or anywhere.
--      A row holds:
--        * a kind from a closed catalogue, and the class that kind belongs to (CHECK-bound);
--        * kind-specific structured parameters and the exact wording, bound by a sha256 the
--          database itself recomputes — the wording cannot drift from its hash;
--        * for an evidence-backed claim, the evidence CONDITION it was confirmed under (a P3 rule
--          id + version + condition, e.g. "served customers ≥ 500"), never the counts behind it.
--          Whether the condition still holds is re-evaluated on read; the row is not edited when
--          evidence moves;
--        * the owner's confirmation (always — a row exists only once an owner confirmed it), an
--          optional private verification document reference, an optional expiry, and public-use
--          approval as a SEPARATE later act: no row can be created already approved;
--        * history: a change retires the row and inserts a new one; nothing is deleted.
--   2. "ConversionChannel" + "BusinessIdentityStatement"."channel": an owner objective
--      (PRIMARY_OBJECTIVE / SECONDARY_OBJECTIVE, P2's owner conversion preference) may name the
--      channel it is meant through — REQUEST_QUOTE via WHATSAPP_CLOUD, BOOK via PHONE, BUY via
--      EXTERNAL_LINK. Optional; existing rows keep NULL ("no channel stated").
--   3. P2 CHECK updates for the labels the previous migration added:
--        * CONVERSION_DECLARATION is a CODED dimension (code, no text, never public-use);
--        * PUBLIC_WHATSAPP is bound to WhatsAppConnection.displayPhoneNumber. As for every P2 fact,
--          the authority row stores only a sha256 of the approved value — the number is never copied.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   - no evidence, signal, capability, conflict or recommendation table: those are projections
--     (recommendations reuse BusinessInsight);
--   - no column on WhatsAppConnection / Business / BusinessProfile;
--   - no public shop / external-commerce URL authority: no canonical source exists, so
--     "BUY via EXTERNAL_LINK" stays without one (the EXTERNAL_SHOP declaration is not a URL);
--   - no foreign key to a document table: the private supporting document of a licence or
--     certificate is referenced by its own storage key + sha256 on the claim. Document belongs to
--     the financial-document pipeline (OCR, payables) and BusinessAsset to marketing assets with a
--     public-use flag; a licence scan must enter neither;
--   - nothing about Offer / Coupon / RedemptionEvent (excluded from P3 until their tenant posture
--     is fixed);
--   - no backfill. Existing businesses start with zero claims. Unknown stays unknown.
--
-- Additive except for the two P2 CHECK constraints, which are replaced by strict supersets of
-- themselves (every row valid before is valid after).

-- ── 1. Channel on owner objectives ───────────────────────────────────────────────────────────

CREATE TYPE "ConversionChannel" AS ENUM (
  'WHATSAPP_CLOUD',
  'WHATSAPP_LINK',
  'PHONE',
  'IN_PERSON',
  'EXTERNAL_LINK',
  'EMAIL',
  'DUBIZ_FORM',
  'DUBIZ_BOOKING',
  'DUBIZ_CHECKOUT'
);

ALTER TABLE "BusinessIdentityStatement" ADD COLUMN "channel" "ConversionChannel";

ALTER TABLE "BusinessIdentityStatement"
  DROP CONSTRAINT "BusinessIdentityStatement_value_shape",
  ADD CONSTRAINT "BusinessIdentityStatement_value_shape" CHECK (
    (
      "dimension" IN ('TARGET_AUDIENCE', 'PRIMARY_OBJECTIVE', 'SECONDARY_OBJECTIVE', 'TONE', 'POSITIONING', 'CONVERSION_DECLARATION')
      AND "code" IS NOT NULL AND "text" IS NULL
      AND "code" ~ '^[A-Z][A-Z_]{1,39}$'
    )
    OR (
      "dimension" IN ('DESCRIPTION', 'SPECIALIZATION', 'DIFFERENTIATOR', 'SERVICE_AREA')
      AND "text" IS NOT NULL AND "code" IS NULL
      AND char_length(btrim("text")) BETWEEN 1 AND 500
    )
  ),
  -- A channel belongs only to an objective, and never to a discovery objective (discovery is
  -- on-page; it has no channel of its own).
  ADD CONSTRAINT "BusinessIdentityStatement_channel_shape" CHECK (
    "channel" IS NULL
    OR (
      "dimension" IN ('PRIMARY_OBJECTIVE', 'SECONDARY_OBJECTIVE')
      AND COALESCE("code" NOT IN ('DISCOVER_SERVICES', 'DISCOVER_PRODUCTS'), false)
    )
  );

-- ── 2. P2 fact source for the new fact ──────────────────────────────────────────────────────

ALTER TABLE "BusinessIdentityFactAuthority"
  DROP CONSTRAINT "BusinessIdentityFactAuthority_source_field",
  ADD CONSTRAINT "BusinessIdentityFactAuthority_source_field" CHECK (
    ("fact" = 'BUSINESS_NAME'  AND "sourceField" = 'Business.name')
    OR ("fact" = 'CITY'             AND "sourceField" = 'BusinessProfile.city')
    OR ("fact" = 'OPENING_HOURS'    AND "sourceField" = 'BusinessProfile.openingHours')
    OR ("fact" = 'PUBLIC_PHONE'     AND "sourceField" = 'BusinessProfile.billingPhone')
    OR ("fact" = 'PUBLIC_EMAIL'     AND "sourceField" = 'BusinessProfile.billingEmail')
    OR ("fact" = 'PUBLIC_ADDRESS'   AND "sourceField" = 'BusinessProfile.billingAddress')
    OR ("fact" = 'PUBLIC_WHATSAPP'  AND "sourceField" = 'WhatsAppConnection.displayPhoneNumber')
  );

-- ── 3. Trust claims ──────────────────────────────────────────────────────────────────────────

CREATE TYPE "TrustClaimKind" AS ENUM (
  'FOUNDED_YEAR',
  'SERVED_CUSTOMERS',
  'LICENSED',
  'CERTIFIED',
  'AUTHORIZED_DEALER',
  'GUARANTEE'
);

-- PROHIBITED is part of the vocabulary (the catalogue classifies "number 1", "leading", … as
-- prohibited) but no kind maps to it, so no row can ever carry it.
CREATE TYPE "TrustClaimClass" AS ENUM ('SAFE_FACTUAL', 'OWNER_ASSERTED', 'VERIFICATION_REQUIRED', 'PROHIBITED');

CREATE TYPE "TrustClaimStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- Only what exists: the owner attests and keeps a private supporting document. No external
-- verifier exists, so no label for one is created.
CREATE TYPE "TrustVerificationMethod" AS ENUM ('OWNER_DOCUMENT');

CREATE TABLE "BusinessTrustClaim" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "claimKind" "TrustClaimKind" NOT NULL,
  "claimClass" "TrustClaimClass" NOT NULL,
  -- Distinguishes several ACTIVE claims of one kind (two certifications); 'default' otherwise.
  "scopeKey" TEXT NOT NULL DEFAULT 'default',
  "params" JSONB NOT NULL,
  "wording" TEXT NOT NULL,
  "wordingHash" TEXT NOT NULL,
  "evidenceRuleId" TEXT,
  "evidenceRuleVersion" TEXT,
  "evidenceCondition" JSONB,
  "confirmedByUserId" INTEGER NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verificationMethod" "TrustVerificationMethod",
  "verificationAttachmentKey" TEXT,
  "verificationAttachmentSha256" TEXT,
  "verificationAttachmentMimeType" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "publicUseApproved" BOOLEAN NOT NULL DEFAULT false,
  "publicUseApprovedAt" TIMESTAMP(3),
  "publicUseApprovedByUserId" INTEGER,
  "status" "TrustClaimStatus" NOT NULL DEFAULT 'ACTIVE',
  "retiredAt" TIMESTAMP(3),
  "retiredByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessTrustClaim_pkey" PRIMARY KEY ("id"),

  -- The class is a property of the kind, not a choice. PROHIBITED is unreachable.
  CONSTRAINT "BusinessTrustClaim_kind_class" CHECK (
    ("claimKind" = 'SERVED_CUSTOMERS' AND "claimClass" = 'SAFE_FACTUAL')
    OR ("claimKind" IN ('FOUNDED_YEAR', 'GUARANTEE') AND "claimClass" = 'OWNER_ASSERTED')
    OR ("claimKind" IN ('LICENSED', 'CERTIFIED', 'AUTHORIZED_DEALER') AND "claimClass" = 'VERIFICATION_REQUIRED')
  ),

  CONSTRAINT "BusinessTrustClaim_scope_key" CHECK ("scopeKey" ~ '^[a-z0-9][a-z0-9:_.-]{0,79}$'),

  CONSTRAINT "BusinessTrustClaim_params" CHECK (
    jsonb_typeof("params") = 'object' AND octet_length("params"::text) <= 4096
  ),

  CONSTRAINT "BusinessTrustClaim_wording" CHECK (char_length(btrim("wording")) BETWEEN 1 AND 300),

  -- The hash is recomputed by the database: wording and hash can never disagree.
  CONSTRAINT "BusinessTrustClaim_wording_hash" CHECK (
    "wordingHash" = encode(sha256(convert_to("wording", 'UTF8')), 'hex')
  ),

  -- A CHECK that evaluates to NULL PASSES. Every predicate below that touches a nullable column is
  -- therefore wrapped in COALESCE(…, false) or guarded by an explicit IS NOT NULL, so a missing
  -- value can never satisfy a branch by being unknown.

  -- Evidence-backed (SAFE_FACTUAL) claims always name the P3 rule and the condition they were
  -- confirmed under; owner-asserted and verification claims never pretend to have one.
  CONSTRAINT "BusinessTrustClaim_evidence_shape" CHECK (
    (
      "claimClass" = 'SAFE_FACTUAL'
      AND "evidenceRuleId" IS NOT NULL AND "evidenceRuleVersion" IS NOT NULL AND "evidenceCondition" IS NOT NULL
      AND COALESCE("evidenceRuleId" ~ '^p3\.[a-z0-9_.]{1,80}$', false)
      AND COALESCE("evidenceRuleVersion" ~ '^p3\.evidence\.v[0-9]{1,3}$', false)
      AND COALESCE(jsonb_typeof("evidenceCondition") = 'object', false)
      AND COALESCE(octet_length("evidenceCondition"::text) <= 1024, false)
    )
    OR (
      "claimClass" <> 'SAFE_FACTUAL'
      AND "evidenceRuleId" IS NULL AND "evidenceRuleVersion" IS NULL AND "evidenceCondition" IS NULL
    )
  ),

  CONSTRAINT "BusinessTrustClaim_confirmed_by" CHECK ("confirmedByUserId" > 0),

  -- Verification is all-or-nothing, exists only for verification-required kinds, and points at a
  -- private stored object by key + content hash (never a URL: no scheme, no ':' allowed).
  CONSTRAINT "BusinessTrustClaim_verification_shape" CHECK (
    (
      "verificationMethod" IS NULL AND "verificationAttachmentKey" IS NULL
      AND "verificationAttachmentSha256" IS NULL AND "verificationAttachmentMimeType" IS NULL
      AND "verifiedAt" IS NULL
    )
    OR (
      "claimClass" = 'VERIFICATION_REQUIRED'
      AND "verificationMethod" IS NOT NULL AND "verifiedAt" IS NOT NULL
      AND "verificationAttachmentKey" IS NOT NULL AND "verificationAttachmentSha256" IS NOT NULL
      AND "verificationAttachmentMimeType" IS NOT NULL
      AND COALESCE(char_length("verificationAttachmentKey") BETWEEN 1 AND 512, false)
      AND COALESCE("verificationAttachmentKey" ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$', false)
      AND COALESCE("verificationAttachmentKey" !~ '(^|/)\.\.(/|$)', false)
      AND COALESCE("verificationAttachmentSha256" ~ '^[0-9a-f]{64}$', false)
      AND COALESCE("verificationAttachmentMimeType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'), false)
    )
  ),

  CONSTRAINT "BusinessTrustClaim_valid_until" CHECK ("validUntil" IS NULL OR "validUntil" > "confirmedAt"),

  -- Public use always says when and by whom.
  CONSTRAINT "BusinessTrustClaim_public_use" CHECK (
    ("publicUseApproved" = false AND "publicUseApprovedAt" IS NULL AND "publicUseApprovedByUserId" IS NULL)
    OR (
      "publicUseApproved" = true AND "publicUseApprovedAt" IS NOT NULL
      AND "publicUseApprovedByUserId" IS NOT NULL AND "publicUseApprovedByUserId" > 0
    )
  ),

  -- A verification-required claim is never public without its owner-provided document.
  CONSTRAINT "BusinessTrustClaim_public_needs_verification" CHECK (
    "publicUseApproved" = false OR "claimClass" <> 'VERIFICATION_REQUIRED' OR "verifiedAt" IS NOT NULL
  ),

  -- Only an owner retires a claim; a retirement always says when and by whom.
  CONSTRAINT "BusinessTrustClaim_retired_shape" CHECK (
    ("status" = 'ACTIVE' AND "retiredAt" IS NULL AND "retiredByUserId" IS NULL)
    OR (
      "status" = 'RETIRED' AND "retiredAt" IS NOT NULL
      AND "retiredByUserId" IS NOT NULL AND "retiredByUserId" > 0
    )
  )
);

CREATE UNIQUE INDEX "BusinessTrustClaim_id_businessId_key" ON "BusinessTrustClaim"("id", "businessId");

CREATE INDEX "BusinessTrustClaim_businessId_status_claimKind_idx"
  ON "BusinessTrustClaim"("businessId", "status", "claimKind");

-- PARTIAL UNIQUE INDEX (raw SQL, not expressible in Prisma): one ACTIVE claim per kind and scope.
-- Retired rows keep their place as history.
CREATE UNIQUE INDEX "BusinessTrustClaim_active_kind_scope_key"
  ON "BusinessTrustClaim"("businessId", "claimKind", "scopeKey")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "BusinessTrustClaim" ADD CONSTRAINT "BusinessTrustClaim_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Tenant isolation: per-command policies, no FOR ALL, no DELETE policy ──────────────────────
ALTER TABLE "BusinessTrustClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessTrustClaim" FORCE ROW LEVEL SECURITY;

CREATE POLICY p3_trust_claim_select ON "BusinessTrustClaim" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- A row enters ACTIVE and NOT public: public use is always a second, separate act.
CREATE POLICY p3_trust_claim_insert ON "BusinessTrustClaim" FOR INSERT
  WITH CHECK (
    "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
    AND "status" = 'ACTIVE'
    AND "publicUseApproved" = false
  );

-- Only an ACTIVE row of the tenant can change; a RETIRED row is frozen history.
CREATE POLICY p3_trust_claim_update ON "BusinessTrustClaim" FOR UPDATE
  USING (
    "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
    AND "status" = 'ACTIVE'
  )
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Runtime privileges, named explicitly (the owner's default ACL would otherwise hand app_runtime
-- DELETE and a table-wide UPDATE). UPDATE is column-scoped: approval, verification and retirement
-- only. Kind, class, parameters, wording, evidence condition, confirmation, expiry and tenant are
-- immutable — changing any of them is a new claim.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "BusinessTrustClaim" FROM app_runtime;
    GRANT SELECT, INSERT ON "BusinessTrustClaim" TO app_runtime;
    GRANT UPDATE (
      "publicUseApproved", "publicUseApprovedAt", "publicUseApprovedByUserId",
      "verificationMethod", "verificationAttachmentKey", "verificationAttachmentSha256",
      "verificationAttachmentMimeType", "verifiedAt",
      "status", "retiredAt", "retiredByUserId",
      "updatedAt"
    ) ON "BusinessTrustClaim" TO app_runtime;
    REVOKE ALL ON SEQUENCE "BusinessTrustClaim_id_seq" FROM app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessTrustClaim_id_seq" TO app_runtime;
  END IF;
END
$do$;

REVOKE ALL ON "BusinessTrustClaim" FROM PUBLIC;
