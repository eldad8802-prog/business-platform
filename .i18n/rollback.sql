-- Rollback for docs/i18n-multicurrency/proposed-migration.sql (proven in CI on an ephemeral DB only).
DROP TABLE IF EXISTS "UserLocalePreference";
DROP TABLE IF EXISTS "BusinessLocaleSettings";
DROP TABLE IF EXISTS "FxRate";
DROP FUNCTION IF EXISTS public.business_locale_base_currency_guard();
DROP FUNCTION IF EXISTS public.fx_rate_append_only_guard();
