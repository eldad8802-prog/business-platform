-- LAB ONLY (never Production): the platform-admin read plane as Production has it, for the UI e2e
-- (.sli/correction-ui.e2e.mts). In the lab app_admin is created after the ledger is replayed, so the earlier
-- migrations' role-guarded grants to it never ran; Production has them. Read from a copy of Production (the isolated
-- Preview branch, 2026-11-17): column grants on Business / User / BusinessProfile, SELECT on the tables below,
-- INSERT on PlatformAuditEvent only, and the permissive p7adm_read policies.
DO $$
DECLARE t text;
BEGIN
  GRANT SELECT ("id", "name", "archivedAt", "archivedByUserId", "createdAt", "updatedAt", "deletionRequestedAt", "deletedAt")
    ON public."Business" TO app_admin;
  GRANT SELECT ("id", "email", "name", "businessId", "lastLoginAt", "loginCount", "createdAt", "emailVerifiedAt")
    ON public."User" TO app_admin;
  GRANT SELECT ("id", "businessId", "createdAt", "onboardingCompletedAt") ON public."BusinessProfile" TO app_admin;
  FOREACH t IN ARRAY ARRAY['AccountantBusinessAlert', 'AccountantOpsAlert', 'AccountantOpsRun', 'BillingDocument', 'ContentRun',
    'Conversation', 'Document', 'EmailConnection', 'ExtractionEvidence', 'ExtractionSnapshot', 'FinancialRecord',
    'LegalIdentityCorrectionAttachment', 'LegalIdentityCorrectionRequest', 'PlatformAuditEvent', 'PlatformFeaturePolicy',
    'ProductUsageEvent', 'ReviewEvent', 'SecurityEvent', 'SliceDecision', 'WhatsAppAttachmentImport'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN EXECUTE format('GRANT SELECT ON public.%I TO app_admin', t); END IF;
  END LOOP;
  GRANT INSERT ON public."PlatformAuditEvent" TO app_admin;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_admin;
  FOREACH t IN ARRAY ARRAY['AccountantBusinessAlert', 'BillingDocument', 'BusinessProfile', 'ContentRun', 'Conversation', 'Document',
    'EmailConnection', 'ExtractionEvidence', 'ExtractionSnapshot', 'FinancialRecord', 'LegalIdentityCorrectionAttachment',
    'LegalIdentityCorrectionRequest', 'ReviewEvent', 'SliceDecision', 'WhatsAppAttachmentImport'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'p7adm_read') THEN
      EXECUTE format('CREATE POLICY p7adm_read ON public.%I AS PERMISSIVE FOR SELECT TO app_admin USING (true)', t);
    END IF;
  END LOOP;
  IF to_regclass('public."SecurityEvent"') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SecurityEvent' AND policyname = 'secf_security_event_admin_read') THEN
    CREATE POLICY secf_security_event_admin_read ON public."SecurityEvent" AS PERMISSIVE FOR SELECT TO app_admin USING (true);
  END IF;
END $$;
