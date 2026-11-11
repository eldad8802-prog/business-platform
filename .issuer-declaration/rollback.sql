-- Rollback of 20261123090000_issuer_declaration — run as the migration owner, ONLY with owner approval.
-- Order matters: the triggers on the EXISTING tables ("BillingDocument", "BusinessProfile") go first, otherwise
-- every issue (status -> ISSUED) and every identity-column write would fail on a missing relation.
-- Refuses when any declaration, opening or enforcement row exists (history is never silently dropped).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessIssuerDeclaration") OR EXISTS (SELECT 1 FROM "BillingSeriesOpening")
     OR EXISTS (SELECT 1 FROM "IssuerDeclarationEnforcement") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: issuer-declaration records exist';
  END IF;
END $$;
DROP TRIGGER IF EXISTS "BillingDocument_issue_requires_declaration" ON "BillingDocument";
DROP TRIGGER IF EXISTS "BillingDocument_insert_issued_requires_declaration" ON "BillingDocument";
DROP TRIGGER IF EXISTS "BusinessProfile_issuer_identity_lock" ON "BusinessProfile";
DROP TRIGGER IF EXISTS "BusinessProfile_issuer_identity_lock_insert" ON "BusinessProfile";
DROP TRIGGER IF EXISTS "BillingDocumentNumberSequence_series_opening" ON "BillingDocumentNumberSequence";
DROP TABLE IF EXISTS "BusinessIssuerDeclaration", "BillingSeriesOpening", "IssuerDeclarationEnforcement" CASCADE;
DROP FUNCTION IF EXISTS public.issuer_records_append_only_guard(), public.issuer_declaration_chain_guard(),
  public.issuer_designation_origin_guard(), public.series_opening_unused_guard(), public.issuer_records_truncate_guard(),
  public.issuer_issue_requires_declaration(), public.issuer_profile_identity_lock(),
  public.issuer_business_is_being_deleted(integer), public.series_opening_apply();
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('issuer_designate_authorized_user','issuer_designate_initial','issuer_declaration_erase')
  LOOP EXECUTE 'DROP FUNCTION ' || f; END LOOP;
END $$;
DROP TYPE IF EXISTS "IssuerTrack", "IssuerLegalForm", "IssuerVatStatus", "IssuerIdType", "IssuerDeclarationKind",
  "IssuerAuthorityBasis", "IssuerReauthMethod", "SeriesOpeningSource";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261123090000_issuer_declaration';
COMMIT;
