-- M6 · First-wave acquisition connectors — the trusted provider-resource → business mapping
-- (migration only; the code that uses it ships separately, behind three features that stay OFF).
--
-- WHY A TABLE
--   Business Intake (M3/M4) resolves the tenant ONLY through an adapter's trusted resolver; it never
--   reads a businessId from a request. WhatsApp has WhatsAppConnection. The acquisition sources have
--   nothing yet: a Meta Page, a Google Ads lead form webhook and a website form endpoint must each be
--   bound to exactly one business by a record Dubiz created when the OWNER connected it.
--   One provider-neutral table serves all three — a source adds a sourceKey value, not a table.
--
--   meta.lead_ads     the business's Facebook Page (externalResourceId = page id). Leads from
--                     Facebook AND Instagram lead ads belong to that Page. The Page access token
--                     (needed to read the lead) is stored AES-256-GCM encrypted, never in clear.
--   google.lead_form  an opaque endpoint (publicId in the webhook URL) + the shared key Google sends
--                     as google_key, stored as a sha256 hash only.
--   web.form          an opaque endpoint (publicId) + a server key (sha256 hash only) and, for
--                     browser posts, the exact origins the owner allowed.
--
-- TENANT BOUNDARY
--   * FORCE row-level security, per-command policies, no DELETE policy (a connection is revoked,
--     never erased by the app; Business deletion cascades as the table owner).
--   * One LIVE mapping per provider resource: a partial unique index on (sourceKey,
--     externalResourceId) for every non-revoked row — a Page cannot route to two businesses.
--   * Inbound requests arrive with no tenant. Three SECURITY DEFINER functions answer only "which
--     business owns this exact key", by equality on a unique value, returning ids (and, for the
--     browser endpoint, the allowed origins) — never a hash, a token or another tenant's row.
--     search_path pinned; EXECUTE revoked from PUBLIC, granted to app_runtime only.
--
-- FEATURES
--   acquisition_meta_lead_ads, acquisition_google_lead_forms, acquisition_web_forms — defined OFF
--   (defaultEnabled false, globalEnabled false). Nothing flows for any business until the owner
--   enables a source for that business.
--
-- EXPAND-ONLY. No existing table, column, policy, grant or row changes.

-- ── 1. Features (default off) ───────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES
  ('acquisition_meta_lead_ads',     'לידים מ־Meta (פייסבוק ואינסטגרם)', 'integrations', 'קבלת לידים מטופסי Lead Ads של עמוד פייסבוק — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP),
  ('acquisition_google_lead_forms', 'לידים מטופסי Google Ads',          'integrations', 'קבלת לידים מטופסי לידים של Google Ads (webhook) — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP),
  ('acquisition_web_forms',         'לידים מטופס באתר',                  'integrations', 'קבלת לידים מטופס יצירת קשר באתר העסק — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES
  ('acquisition_meta_lead_ads',     false, false, CURRENT_TIMESTAMP),
  ('acquisition_google_lead_forms', false, false, CURRENT_TIMESTAMP),
  ('acquisition_web_forms',         false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;

-- ── 2. AcquisitionConnection ────────────────────────────────────────────────────

CREATE TABLE "AcquisitionConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    -- Opaque, random, URL-safe. Appears in webhook / form URLs; carries no tenant information.
    "publicId" TEXT NOT NULL,
    -- The business's own resource at the provider (Meta Page id). Never a person.
    "externalResourceId" TEXT,
    -- Owner-facing label (page / form / site name). Business data, not a person.
    "label" TEXT,
    -- sha256 (hex) of the shared key; the key itself is shown to the owner once and never stored.
    "keyHash" TEXT,
    "keyHint" TEXT,
    "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- AES-256-GCM encrypted provider credential (Meta Page access token). AAD binds it to the row.
    "credentialCiphertext" TEXT,
    "credentialIv" TEXT,
    "credentialTag" TEXT,
    "credentialKeyId" TEXT,
    "credentialExpiresAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "lastEventAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcquisitionConnection_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "AcquisitionConnection_source_key" CHECK (
      "sourceKey" IN ('meta.lead_ads', 'google.lead_form', 'web.form')
    ),
    CONSTRAINT "AcquisitionConnection_status" CHECK (
      "status" IN ('ACTIVE', 'PAUSED', 'ERROR', 'REVOKED')
    ),
    CONSTRAINT "AcquisitionConnection_revoked_shape" CHECK (
      ("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
    ),
    CONSTRAINT "AcquisitionConnection_public_id" CHECK ("publicId" ~ '^[A-Za-z0-9_-]{24,64}$'),
    CONSTRAINT "AcquisitionConnection_external_resource" CHECK (
      "externalResourceId" IS NULL OR "externalResourceId" ~ '^[A-Za-z0-9_.:-]{1,64}$'
    ),
    CONSTRAINT "AcquisitionConnection_key_hash" CHECK ("keyHash" IS NULL OR "keyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AcquisitionConnection_key_hint" CHECK ("keyHint" IS NULL OR char_length("keyHint") BETWEEN 1 AND 8),
    CONSTRAINT "AcquisitionConnection_label" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 120),
    CONSTRAINT "AcquisitionConnection_error_code" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,64}$'),
    CONSTRAINT "AcquisitionConnection_origins" CHECK (cardinality("allowedOrigins") <= 10),
    -- The encrypted credential is all-or-nothing.
    CONSTRAINT "AcquisitionConnection_credential_shape" CHECK (
      ("credentialCiphertext" IS NULL AND "credentialIv" IS NULL AND "credentialTag" IS NULL AND "credentialKeyId" IS NULL)
      OR ("credentialCiphertext" IS NOT NULL AND "credentialIv" IS NOT NULL AND "credentialTag" IS NOT NULL AND "credentialKeyId" IS NOT NULL)
    ),
    -- What each source needs to be resolvable at all.
    CONSTRAINT "AcquisitionConnection_source_shape" CHECK (
      ("sourceKey" = 'meta.lead_ads' AND "externalResourceId" IS NOT NULL AND "keyHash" IS NULL)
      OR ("sourceKey" IN ('google.lead_form', 'web.form') AND "keyHash" IS NOT NULL AND "credentialCiphertext" IS NULL)
    )
);

CREATE UNIQUE INDEX "AcquisitionConnection_publicId_key" ON "AcquisitionConnection"("publicId");
CREATE UNIQUE INDEX "AcquisitionConnection_id_businessId_key" ON "AcquisitionConnection"("id", "businessId");
CREATE INDEX "AcquisitionConnection_businessId_sourceKey_status_idx" ON "AcquisitionConnection"("businessId", "sourceKey", "status");

-- PARTIAL UNIQUE INDEX (raw SQL, not expressible in Prisma): one live mapping per provider resource.
CREATE UNIQUE INDEX "AcquisitionConnection_live_resource_key"
  ON "AcquisitionConnection"("sourceKey", "externalResourceId")
  WHERE "externalResourceId" IS NOT NULL AND "status" <> 'REVOKED';

ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Tenant isolation: per-command policies, no FOR ALL, no DELETE policy ─────

ALTER TABLE "AcquisitionConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AcquisitionConnection" FORCE ROW LEVEL SECURITY;

CREATE POLICY m6_acquisition_connection_select ON "AcquisitionConnection" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m6_acquisition_connection_insert ON "AcquisitionConnection" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m6_acquisition_connection_update ON "AcquisitionConnection" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "AcquisitionConnection" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AcquisitionConnection_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "AcquisitionConnection" FROM app_runtime;
  END IF;
END
$do$;

-- ── 4. Pre-tenant lookups (the bootstrap boundary, as sec_c_* does for WhatsApp / POS) ──

-- Google webhook / website server post: exact endpoint + exact key hash → the live connection.
CREATE OR REPLACE FUNCTION public.m6_acquisition_resolve_keyed(p_source_key text, p_public_id text, p_key_hash text)
RETURNS TABLE (connection_id integer, business_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT c."id", c."businessId"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."publicId" = p_public_id
     AND c."keyHash" = p_key_hash
     AND c."status" = 'ACTIVE'
$fn$;

-- Website browser post: exact endpoint → the live connection and the origins its owner allowed.
CREATE OR REPLACE FUNCTION public.m6_acquisition_resolve_public(p_source_key text, p_public_id text)
RETURNS TABLE (connection_id integer, business_id integer, allowed_origins text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT c."id", c."businessId", c."allowedOrigins"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."publicId" = p_public_id
     AND c."status" = 'ACTIVE'
$fn$;

-- Meta webhook: the provider resource (Page id, signed by Meta) → the live connection.
CREATE OR REPLACE FUNCTION public.m6_acquisition_resolve_resource(p_source_key text, p_resource_id text)
RETURNS TABLE (connection_id integer, business_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT c."id", c."businessId"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."externalResourceId" = p_resource_id
     AND c."status" = 'ACTIVE'
$fn$;

-- Intake sweeper: businesses that may hold receipts of a source (any status — a receipt Dubiz
-- accepted is finished whatever the connection does next). Ids only.
CREATE OR REPLACE FUNCTION public.m6_acquisition_tenants(p_source_key text)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT DISTINCT c."businessId"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
$fn$;

REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_keyed(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_public(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_resource(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m6_acquisition_tenants(text) FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_keyed(text, text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_public(text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_resource(text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_tenants(text) TO app_runtime;
  END IF;
END
$do$;
