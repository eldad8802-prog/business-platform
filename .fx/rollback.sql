-- Reversal of 20261025090000_currency_settings_fx_rates. OWNER-RUN ONLY (as the migration role), never automatic.
--
-- Safe only while no code reads or writes the new objects: the application PR not deployed, or reverted and
-- its deployment replaced FIRST (docs/i18n-multicurrency/MIGRATION-RUNBOOK.md §6). It REFUSES while any of
-- the three new tables holds a row: discarding an owner's language / currency choices or the stored rates is
-- a separate, explicit owner decision — never a side effect of a rollback.
--
-- What it removes: the three tables (with their policies, triggers, indexes, sequence and grants), the four
-- functions, the role fx_rate_writer (refused, and the whole rollback with it, while anything still depends
-- on the role — e.g. a LOGIN member the owner created, or a grant in another database), and its own ledger row
-- in the same transaction, so a later release re-applies the migration whole. (The migration role itself is a
-- member — PostgreSQL 16+ grants the creator ADMIN on a role it creates — and does not count.)
-- Nothing that existed before the migration is touched: it changed no existing object.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessLocaleSettings") OR EXISTS (SELECT 1 FROM "UserLocalePreference")
     OR EXISTS (SELECT 1 FROM "FxRate") THEN
    RAISE EXCEPTION 'currency settings / fx rates rollback refused: rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
              JOIN pg_roles u ON u.oid = m.member
             WHERE r.rolname = 'fx_rate_writer' AND u.rolcanlogin AND u.rolname <> current_user) THEN
    RAISE EXCEPTION 'currency settings / fx rates rollback refused: a LOGIN role is a member of fx_rate_writer (retire it first)';
  END IF;
END
$rb$;

DROP TABLE "UserLocalePreference";
DROP TABLE "BusinessLocaleSettings";
DROP TABLE "FxRate";
DROP FUNCTION public.business_base_currency_locked();
DROP FUNCTION public.business_locale_base_currency_lock();
DROP FUNCTION public.business_financial_data_exists(integer);
DROP FUNCTION public.fx_rate_append_only_guard();
DROP ROLE fx_rate_writer;

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates';
COMMIT;
