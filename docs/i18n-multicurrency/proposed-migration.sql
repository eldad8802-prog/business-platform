-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT A MIGRATION YET. Lives under docs/ on purpose so no release gate can apply it.
-- Milestone C-1: language / region / currency settings + exchange-rate reference data.
-- Becomes prisma/migrations/<ts>_locale_currency_foundation/migration.sql only after owner approval.
--
-- Compatibility: purely ADDITIVE. No existing table, column, row or policy is altered. A business
-- with no BusinessLocaleSettings row reads as he / IL / Asia/Jerusalem / ILS — exactly today's
-- behaviour — so there is NO backfill and no data change.
-- Rollback: DROP TABLE "UserLocalePreference", "BusinessLocaleSettings", "FxRate" (nothing else
-- references them until the application code that reads them is enabled).
-- Isolation: tenant tables ENABLE + FORCE RLS on app.current_business_id (same pattern as
-- 20261018090000_daily_tasks_foundation); FxRate holds no tenant data and is read-only to app_runtime.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. BusinessLocaleSettings — one row per business (absent ⇒ defaults) ─────────────────────────
CREATE TABLE "BusinessLocaleSettings" (
  "businessId"          INTEGER      NOT NULL,
  "locale"              TEXT         NOT NULL DEFAULT 'he',
  "region"              TEXT         NOT NULL DEFAULT 'IL',
  "timeZone"            TEXT         NOT NULL DEFAULT 'Asia/Jerusalem',
  "baseCurrency"        TEXT         NOT NULL DEFAULT 'ILS',
  -- NULL = follow the base currency.
  "displayCurrency"     TEXT,
  -- Set when the business records its first financial row; afterwards the base currency changes
  -- only through a separate controlled process (never a plain UPDATE from the settings screen).
  "baseCurrencyLockedAt" TIMESTAMP(3),
  "version"             INTEGER      NOT NULL DEFAULT 1,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessLocaleSettings_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BusinessLocaleSettings_locale" CHECK ("locale" IN ('he', 'en')),
  CONSTRAINT "BusinessLocaleSettings_region" CHECK ("region" ~ '^[A-Z]{2}$'),
  CONSTRAINT "BusinessLocaleSettings_tz" CHECK (char_length("timeZone") BETWEEN 1 AND 64),
  CONSTRAINT "BusinessLocaleSettings_base" CHECK ("baseCurrency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "BusinessLocaleSettings_display" CHECK ("displayCurrency" IS NULL OR "displayCurrency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "BusinessLocaleSettings_version" CHECK ("version" >= 1)
);
ALTER TABLE "BusinessLocaleSettings" ADD CONSTRAINT "BusinessLocaleSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A locked base currency cannot be changed by the runtime (the controlled process runs as owner).
CREATE OR REPLACE FUNCTION public.business_locale_base_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."baseCurrencyLockedAt" IS NOT NULL
     AND (NEW."baseCurrency" IS DISTINCT FROM OLD."baseCurrency"
          OR NEW."baseCurrencyLockedAt" IS DISTINCT FROM OLD."baseCurrencyLockedAt") THEN
    RAISE EXCEPTION 'BASE_CURRENCY_LOCKED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_locale_base_currency_guard() FROM PUBLIC;
CREATE TRIGGER business_locale_base_currency_guard
  BEFORE UPDATE ON "BusinessLocaleSettings"
  FOR EACH ROW EXECUTE FUNCTION public.business_locale_base_currency_guard();

ALTER TABLE "BusinessLocaleSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessLocaleSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_locale_settings_tenant_select ON "BusinessLocaleSettings" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_locale_settings_tenant_insert ON "BusinessLocaleSettings" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_locale_settings_tenant_update ON "BusinessLocaleSettings" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 2. UserLocalePreference — the interface language of one user in one business ─────────────────
-- Tenant-scoped (businessId, userId) so it rides the existing tenant RLS; survives logout/login and
-- follows the user across devices (the login flow re-issues the dz_locale cookie from it).
CREATE TABLE "UserLocalePreference" (
  "businessId" INTEGER      NOT NULL,
  "userId"     INTEGER      NOT NULL,
  "locale"     TEXT         NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserLocalePreference_pkey" PRIMARY KEY ("businessId", "userId"),
  CONSTRAINT "UserLocalePreference_locale" CHECK ("locale" IN ('he', 'en'))
);
ALTER TABLE "UserLocalePreference" ADD CONSTRAINT "UserLocalePreference_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserLocalePreference" ADD CONSTRAINT "UserLocalePreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserLocalePreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserLocalePreference" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_locale_pref_tenant_select ON "UserLocalePreference" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY user_locale_pref_tenant_insert ON "UserLocalePreference" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY user_locale_pref_tenant_update ON "UserLocalePreference" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 3. FxRate — global reference rates (no tenant data) ─────────────────────────────────────────
-- Rates are facts about the world, identical for every business, so they are NOT tenant rows.
-- app_runtime may only SELECT; the fetcher writes through a separate role (created with the fetcher,
-- not here). Rows are append-only: a correction is a new row with a later fetchedAt.
CREATE TABLE "FxRate" (
  "id"           SERIAL        NOT NULL,
  "base"         TEXT          NOT NULL,
  "quote"        TEXT          NOT NULL,
  "rate"         NUMERIC(20,10) NOT NULL,
  "kind"         TEXT          NOT NULL,
  "source"       TEXT          NOT NULL,
  "rateDate"     DATE          NOT NULL,
  "fetchedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verification" TEXT          NOT NULL DEFAULT 'UNVERIFIED',
  "sourceRef"    TEXT,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxRate_currencies" CHECK ("base" IN ('ILS','USD','EUR') AND "quote" IN ('ILS','USD','EUR') AND "base" <> "quote"),
  CONSTRAINT "FxRate_positive" CHECK ("rate" > 0),
  CONSTRAINT "FxRate_kind" CHECK ("kind" IN ('REPRESENTATIVE', 'DISPLAY')),
  CONSTRAINT "FxRate_source" CHECK ("source" IN ('BANK_OF_ISRAEL', 'MANUAL')),
  CONSTRAINT "FxRate_verification" CHECK ("verification" IN ('VERIFIED', 'UNVERIFIED'))
);
CREATE UNIQUE INDEX "FxRate_identity" ON "FxRate" ("base", "quote", "kind", "source", "rateDate", "fetchedAt");
CREATE INDEX "FxRate_lookup" ON "FxRate" ("base", "quote", "rateDate" DESC);

CREATE OR REPLACE FUNCTION public.fx_rate_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'FX_RATE_APPEND_ONLY' USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION public.fx_rate_append_only_guard() FROM PUBLIC;
CREATE TRIGGER fx_rate_append_only_guard BEFORE UPDATE OR DELETE ON "FxRate"
  FOR EACH ROW EXECUTE FUNCTION public.fx_rate_append_only_guard();

-- ── 4. Privileges ───────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "BusinessLocaleSettings", "UserLocalePreference", "FxRate" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "FxRate_id_seq" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessLocaleSettings" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "BusinessLocaleSettings" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "UserLocalePreference" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "UserLocalePreference" FROM app_runtime;
    GRANT SELECT ON "FxRate" TO app_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "FxRate" FROM app_runtime;
  END IF;
END
$do$;

-- ── 5. Deliberately NOT in this migration (Milestone D, tax-gated) ──────────────────────────────
--  * BillingDocument FX snapshot columns (reportingCurrency, fxRate, fxRateDate, fxRateSource,
--    reportingSubtotal/Vat/Total) — need the approved Israeli rules for foreign-currency tax docs.
--  * FinancialRecord.currency — reports/accountant package depend on it; needs its own plan.
--  * Currency on pricing / inventory / services.
