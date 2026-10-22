-- ============================================================================================================
-- 20261025090000_currency_settings_fx_rates — language / region / currency settings and exchange-rate reference
-- data (multi-currency milestone C-2). Owner approved the direction of docs/i18n-multicurrency (2026-10-22).
-- MIGRATION ONLY: no schema.prisma, no runtime code reads or writes these objects yet.
--
-- 1. "BusinessLocaleSettings": one row per business (locale, region, time zone, base + display currency).
--    Tenant table: RLS ENABLED + FORCED, per-command tenant policies (no DELETE — business deletion cascades),
--    SELECT / INSERT / UPDATE for the runtime. NO BACKFILL: a business without a row reads as the column
--    defaults he / IL / Asia/Jerusalem / ILS / ILS — exactly today's behaviour — and a business created by the
--    current code after this migration has no row either, so "absent ⇒ defaults" is the contract anyway.
-- 2. The base-currency lock, derived from the data (not from a flag someone must remember to set): a trigger
--    refuses to give a business a base currency other than the one it effectively has (ILS when there is no
--    row) once ANY financial row of that business exists. It locks the "Business" row FOR UPDATE first: every
--    financial insert holds FOR KEY SHARE on that row through its foreign key, so a concurrent first financial
--    row and a base-currency change serialise (one waits for the other's commit, then sees it).
--    business_base_currency_locked() tells the runtime, for its own tenant only, whether the lock is on.
-- 3. "UserLocalePreference": the interface language of one user (absent ⇒ Hebrew). Isolated PER USER: every
--    policy requires the row's business AND user to equal the transaction's app.current_business_id AND
--    app.current_user_id (a new transaction-local GUC the application PR sets with the business one); the
--    user must belong to the row's business (the task_user_same_business guard of 20261018090000).
-- 4. "FxRate": global reference rates (facts about the world, not tenant data). Append-only for everyone: a
--    row trigger refuses UPDATE / DELETE and a statement trigger refuses TRUNCATE — the owner included; a
--    correction is a new row with a later fetchedAt. RLS ENABLED + FORCED with a read policy and an append
--    policy only, so even a mistaken UPDATE / DELETE grant reaches no row. app_runtime may only SELECT.
-- 5. fx_rate_writer: a NOLOGIN role (created here if absent, attributes asserted) holding INSERT on "FxRate"
--    and USAGE on its sequence — nothing else. No login exists for it until a separate owner decision.
--
-- Privileges: the owner's DEFAULT PRIVILEGES hand every new table / sequence to the runtime wholesale (the G4
-- finding of 20261018090000); every such grant is taken back first, then exactly what is listed is granted.
-- Additive only: no existing table, column, row, policy, trigger or grant is changed or removed.
-- Reversal: .fx/rollback.sql (owner-run, refuses while any of the new tables holds a row).
-- ============================================================================================================

-- ── 1. BusinessLocaleSettings ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE "BusinessLocaleSettings" (
  "businessId" INTEGER NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'he',
  "region" TEXT NOT NULL DEFAULT 'IL',
  "timeZone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  "baseCurrency" TEXT NOT NULL DEFAULT 'ILS',
  "displayCurrency" TEXT NOT NULL DEFAULT 'ILS',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessLocaleSettings_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BusinessLocaleSettings_locale" CHECK ("locale" IN ('he', 'en')),
  CONSTRAINT "BusinessLocaleSettings_region" CHECK ("region" ~ '^[A-Z]{2}$'),
  -- An IANA zone name (Area/Location[/Sublocation], or UTC); the application validates it against Intl.
  CONSTRAINT "BusinessLocaleSettings_timeZone" CHECK (
    char_length("timeZone") <= 64 AND "timeZone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  -- The money engine's registry (lib/money/currency.ts). Widening it is a deliberate migration.
  CONSTRAINT "BusinessLocaleSettings_baseCurrency" CHECK ("baseCurrency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "BusinessLocaleSettings_displayCurrency" CHECK ("displayCurrency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "BusinessLocaleSettings_version" CHECK ("version" >= 1)
);
ALTER TABLE "BusinessLocaleSettings" ADD CONSTRAINT "BusinessLocaleSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. The base-currency lock ──────────────────────────────────────────────────────────────────────────────

-- Whether a business holds any financial row: the ledgers that carry an amount (and, where they have one, a
-- currency). Child rows (allocations, installments, receipt lines, provider transactions) always belong to a
-- parent listed here. Owner-only: EXECUTE for no one.
CREATE OR REPLACE FUNCTION public.business_financial_data_exists(p_business integer)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM "BillingDocument" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "FinancialRecord" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "FinancialEvent" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "HistoricalFiscalDocument" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "PaymentRequest" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "Payment" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "Cheque" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "PaymentPreparation" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "ExternalTransaction" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "OutboundExecution" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "BusinessObligation" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "Commitment" WHERE "businessId" = p_business)
      OR EXISTS (SELECT 1 FROM "CommerceOrder" WHERE "businessId" = p_business)
$fn$;

-- BEFORE INSERT OR UPDATE OF "baseCurrency": runs as the migration role (BYPASSRLS in Production, asserted at
-- run time — without it FORCE RLS would hide the very rows the lock looks for, so it refuses instead).
--  * no change of the effective base currency (INSERT of 'ILS', UPDATE keeping it) → allowed, no lock taken;
--  * otherwise: READ COMMITTED only (a later snapshot would not see a row committed while it waited), lock the
--    "Business" row FOR UPDATE (conflicts with the FOR KEY SHARE every financial insert takes through its
--    foreign key), then — in a fresh statement snapshot — refuse if any financial row exists.
CREATE OR REPLACE FUNCTION public.business_locale_base_currency_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_from text := CASE WHEN TG_OP = 'INSERT' THEN 'ILS' ELSE OLD."baseCurrency" END;
BEGIN
  IF NEW."baseCurrency" IS NOT DISTINCT FROM v_from THEN
    RETURN NEW;
  END IF;
  IF (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF03',
      MESSAGE = 'BASE_CURRENCY_LOCK_UNVERIFIABLE: the lock runs as a role that cannot see every row; nothing was changed';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF03',
      MESSAGE = 'BASE_CURRENCY_CHANGE_ISOLATION: a base currency changes only under READ COMMITTED; nothing was changed';
  END IF;
  PERFORM 1 FROM "Business" b WHERE b."id" = NEW."businessId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF03',
      MESSAGE = 'BASE_CURRENCY_NO_BUSINESS: the business does not exist; nothing was changed';
  END IF;
  IF public.business_financial_data_exists(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF02',
      MESSAGE = format('BASE_CURRENCY_LOCKED: the business already has financial records; its base currency stays %s', v_from);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "BusinessLocaleSettings_base_currency_lock"
  BEFORE INSERT OR UPDATE OF "baseCurrency" ON "BusinessLocaleSettings"
  FOR EACH ROW EXECUTE FUNCTION public.business_locale_base_currency_lock();

-- For the runtime: is the base currency of the business in the tenant context locked? (A boolean about its
-- own business only; no argument, so it can never ask about another one.)
CREATE OR REPLACE FUNCTION public.business_base_currency_locked()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF03', MESSAGE = 'BASE_CURRENCY_NO_CONTEXT: no tenant context';
  END IF;
  RETURN public.business_financial_data_exists(v_business);
END
$fn$;

ALTER TABLE "BusinessLocaleSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessLocaleSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_locale_settings_tenant_select ON "BusinessLocaleSettings" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_locale_settings_tenant_insert ON "BusinessLocaleSettings" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_locale_settings_tenant_update ON "BusinessLocaleSettings" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 3. UserLocalePreference ────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "UserLocalePreference" (
  "userId" INTEGER NOT NULL,
  "businessId" INTEGER NOT NULL,
  "locale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserLocalePreference_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "UserLocalePreference_locale" CHECK ("locale" IN ('he', 'en'))
);
CREATE INDEX "UserLocalePreference_businessId_idx" ON "UserLocalePreference"("businessId");
ALTER TABLE "UserLocalePreference" ADD CONSTRAINT "UserLocalePreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserLocalePreference" ADD CONSTRAINT "UserLocalePreference_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "UserLocalePreference_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "UserLocalePreference"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

ALTER TABLE "UserLocalePreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserLocalePreference" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_locale_preference_own_select ON "UserLocalePreference" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
     AND "userId" = NULLIF(current_setting('app.current_user_id', true), '')::int);
CREATE POLICY user_locale_preference_own_insert ON "UserLocalePreference" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
          AND "userId" = NULLIF(current_setting('app.current_user_id', true), '')::int);
CREATE POLICY user_locale_preference_own_update ON "UserLocalePreference" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
     AND "userId" = NULLIF(current_setting('app.current_user_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
          AND "userId" = NULLIF(current_setting('app.current_user_id', true), '')::int);

-- ── 4. FxRate ──────────────────────────────────────────────────────────────────────────────────────────────

-- rate = units of "quote" for ONE unit of "base" (lib/money/fx.ts, RATE_SCALE = 10). Only the global kinds
-- live here: REPRESENTATIVE (an official reference rate, e.g. Bank of Israel שער יציג) and DISPLAY
-- (indicative). A TRANSACTION rate belongs to its one transaction and is stored on it, never here.
CREATE TABLE "FxRate" (
  "id" SERIAL NOT NULL,
  "base" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "rate" DECIMAL(20,10) NOT NULL,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "rateDate" DATE NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verification" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "sourceRef" TEXT,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxRate_currencies" CHECK (
    "base" IN ('ILS', 'USD', 'EUR') AND "quote" IN ('ILS', 'USD', 'EUR') AND "base" <> "quote"),
  CONSTRAINT "FxRate_rate_positive" CHECK ("rate" > 0),
  CONSTRAINT "FxRate_kind" CHECK ("kind" IN ('REPRESENTATIVE', 'DISPLAY')),
  CONSTRAINT "FxRate_source" CHECK ("source" IN ('BANK_OF_ISRAEL', 'MANUAL')),
  -- The Bank of Israel publishes representative rates of a foreign currency in shekels, nothing else.
  CONSTRAINT "FxRate_boi_shape" CHECK ("source" <> 'BANK_OF_ISRAEL' OR ("kind" = 'REPRESENTATIVE' AND "quote" = 'ILS')),
  CONSTRAINT "FxRate_verification" CHECK ("verification" IN ('VERIFIED', 'UNVERIFIED')),
  -- No rate for a future day (fetchedAt is UTC; Asia/Jerusalem is at most one civil day ahead).
  CONSTRAINT "FxRate_not_future" CHECK ("rateDate" <= ("fetchedAt" + interval '1 day')::date),
  CONSTRAINT "FxRate_sourceRef_length" CHECK ("sourceRef" IS NULL OR char_length("sourceRef") <= 2048)
);
CREATE UNIQUE INDEX "FxRate_base_quote_kind_source_rateDate_fetchedAt_key"
  ON "FxRate"("base", "quote", "kind", "source", "rateDate", "fetchedAt");
CREATE INDEX "FxRate_base_quote_kind_rateDate_fetchedAt_idx"
  ON "FxRate"("base", "quote", "kind", "rateDate" DESC, "fetchedAt" DESC);

CREATE OR REPLACE FUNCTION public.fx_rate_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'DZF01',
    MESSAGE = format('FX_RATE_APPEND_ONLY: %s on %I is refused; a correction is a new row', TG_OP, TG_TABLE_NAME);
END
$fn$;

CREATE TRIGGER "FxRate_append_only" BEFORE UPDATE OR DELETE ON "FxRate"
  FOR EACH ROW EXECUTE FUNCTION public.fx_rate_append_only_guard();
CREATE TRIGGER "FxRate_no_truncate" BEFORE TRUNCATE ON "FxRate"
  FOR EACH STATEMENT EXECUTE FUNCTION public.fx_rate_append_only_guard();

ALTER TABLE "FxRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FxRate" FORCE ROW LEVEL SECURITY;
-- Reference data: every row is readable / appendable by whoever holds the privilege (grants decide who).
-- No UPDATE or DELETE policy exists, so those reach no row for any role without BYPASSRLS.
CREATE POLICY fx_rate_read ON "FxRate" FOR SELECT USING (true);
CREATE POLICY fx_rate_append ON "FxRate" FOR INSERT WITH CHECK (true);

-- ── 5. Privileges — named explicitly ───────────────────────────────────────────────────────────────────────

-- Whatever the owner's DEFAULT PRIVILEGES handed out on the new tables, the sequence and the functions goes,
-- from every grantee — then exactly what is listed below is granted.
DO $do$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT c.oid::regclass::text AS obj, c.relkind, x.grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.oid IN ('public."BusinessLocaleSettings"'::regclass, 'public."UserLocalePreference"'::regclass,
                     'public."FxRate"'::regclass, 'public."FxRate_id_seq"'::regclass)
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF g.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
    END IF;
  END LOOP;
  FOR g IN
    SELECT DISTINCT p.oid::regprocedure::text AS obj, x.grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN ('public.business_financial_data_exists(integer)'::regprocedure,
                     'public.business_locale_base_currency_lock()'::regprocedure,
                     'public.business_base_currency_locked()'::regprocedure,
                     'public.fx_rate_append_only_guard()'::regprocedure)
       AND x.grantee <> p.proowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
  END LOOP;
END
$do$;
REVOKE ALL ON "BusinessLocaleSettings", "UserLocalePreference", "FxRate" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "FxRate_id_seq" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_financial_data_exists(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_locale_base_currency_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_base_currency_locked() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_rate_append_only_guard() FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessLocaleSettings" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "UserLocalePreference" TO app_runtime;
    GRANT SELECT ON "FxRate" TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.business_base_currency_locked() TO app_runtime;
  END IF;
END
$do$;

-- The rate writer: NOLOGIN, append-only on "FxRate", nothing else. A role of that name that already exists must
-- have exactly this shape — no login, no elevated attribute, no membership in any other role — or nothing is
-- applied. The fetcher's credential will be a separate LOGIN role made a member of it (like app_runtime_prod
-- of app_runtime), by a later owner decision. INSERT without SELECT: the fetcher appends without RETURNING
-- and reads existing rates through the runtime's SELECT.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fx_rate_writer') THEN
    CREATE ROLE fx_rate_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'fx_rate_writer'
               AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication))
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'fx_rate_writer') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZF03',
      MESSAGE = 'FX_RATE_WRITER_SHAPE: the existing role fx_rate_writer is not a plain NOLOGIN role; nothing was applied';
  END IF;
END
$do$;
GRANT INSERT ON "FxRate" TO fx_rate_writer;
GRANT USAGE ON SEQUENCE "FxRate_id_seq" TO fx_rate_writer;
