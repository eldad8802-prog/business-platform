-- ============================================================================================================
-- 20261216090000_activity_packs — DRAFT. NOT APPLIED anywhere. Owner approval required to apply.
--
-- Dubiz phase 2 (owner-approved spec + design, 2026-11-20): a business chooses its activity areas — one primary
-- pack and optional additional packs — and the Home, the "+" sheet, the tools order and the bottom bar's second
-- slot follow that choice. A pack is DISPLAY ONLY: it never grants a capability, never changes a price, never
-- turns a feature flag on. Entitlement stays with feature access (and, later, the subscription plan).
--
--   1. table "BusinessActivityProfile" — at most ONE row per business (the business id is the key):
--        primaryPack      one of APPOINTMENTS | SERVICE | INVENTORY | LEADS | ORDERS
--        additionalPacks  zero to four of the same values, never the primary, no duplicates
--        source           OWNER_SELECTED (the only value written: a row exists only after the owner chose)
--      FORCE RLS by business; the runtime may read, insert and update its own business's row — never delete.
--      No row = the business never chose = the Home behaves exactly as before this migration.
--   2. feature "activity_packs" — definition + global policy, OFF (defaultEnabled false, globalEnabled false).
--      The new screens and the pack-based Home are drawn only while it is ON for a business; turning it on (even
--      for one pilot business) is a separate owner decision.
--
-- Unchanged: every existing table, row, constraint, policy, grant and function. No billing object is read or
-- written. Additive only: dropping the table and the two feature rows restores the previous state exactly.
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."Business"') IS NULL OR to_regclass('public."PlatformFeatureDefinition"') IS NULL
     OR to_regclass('public."PlatformFeaturePolicy"') IS NULL THEN
    RAISE EXCEPTION 'ACTIVITY_PACKS: Business or the platform feature tables are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'ACTIVITY_PACKS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."BusinessActivityProfile"') IS NOT NULL THEN
    RAISE EXCEPTION 'ACTIVITY_PACKS: BusinessActivityProfile already exists; nothing was changed';
  END IF;
END
$do$;

-- ── 1. The table ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "BusinessActivityProfile" (
  "businessId"      INTEGER      NOT NULL,
  "primaryPack"     TEXT         NOT NULL,
  "additionalPacks" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source"          TEXT         NOT NULL DEFAULT 'OWNER_SELECTED',
  "updatedByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessActivityProfile_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BusinessActivityProfile_primary_pack"
    CHECK ("primaryPack" IN ('APPOINTMENTS', 'SERVICE', 'INVENTORY', 'LEADS', 'ORDERS')),
  CONSTRAINT "BusinessActivityProfile_additional_packs"
    CHECK ("additionalPacks" <@ ARRAY['APPOINTMENTS', 'SERVICE', 'INVENTORY', 'LEADS', 'ORDERS']::TEXT[]
       AND cardinality("additionalPacks") <= 4
       AND NOT ("primaryPack" = ANY ("additionalPacks"))
       AND array_position("additionalPacks", NULL) IS NULL),
  CONSTRAINT "BusinessActivityProfile_source" CHECK ("source" IN ('OWNER_SELECTED'))
);

-- No duplicate inside "additionalPacks" (a CHECK cannot run a subquery; a row trigger can).
CREATE OR REPLACE FUNCTION public.business_activity_profile_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF (SELECT count(*) FROM unnest(NEW."additionalPacks")) <> (SELECT count(DISTINCT p) FROM unnest(NEW."additionalPacks") AS p) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACTIVITY_PACKS_DUPLICATE: an additional pack is listed twice';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_activity_profile_guard() FROM PUBLIC;

CREATE TRIGGER "BusinessActivityProfile_guard" BEFORE INSERT OR UPDATE ON "BusinessActivityProfile"
  FOR EACH ROW EXECUTE FUNCTION public.business_activity_profile_guard();

ALTER TABLE "BusinessActivityProfile" ADD CONSTRAINT "BusinessActivityProfile_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessActivityProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessActivityProfile" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_activity_profile_tenant_select ON "BusinessActivityProfile" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_activity_profile_tenant_insert ON "BusinessActivityProfile" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_activity_profile_tenant_update ON "BusinessActivityProfile" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Grants: exactly what the application needs, nothing inherited from default privileges.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname = 'BusinessActivityProfile'
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
  END LOOP;
END
$do$;
GRANT SELECT, INSERT, UPDATE ON "BusinessActivityProfile" TO app_runtime;

-- ── 2. The feature `activity_packs` (OFF) ────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('activity_packs', 'חבילות פעילות', 'experience',
        'התאמת מסך הבית, הסרגל והכלים לתחומי הפעילות שבעל העסק בחר — תצוגה בלבד, כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('activity_packs', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
