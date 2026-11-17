-- LOCAL LAB ONLY: give app_admin the read plane Production has (read from the isolated Preview branch, a copy of
-- Production): SELECT on 21 tables, INSERT on PlatformAuditEvent, and the 16 permissive read policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AccountantBusinessAlert','AccountantOpsAlert','AccountantOpsRun','BillingDocument','Business','ContentRun',
    'Conversation','Document','EmailConnection','ExtractionEvidence','ExtractionSnapshot','FinancialRecord','LegalIdentityCorrectionAttachment',
    'LegalIdentityCorrectionRequest','PlatformAuditEvent','PlatformFeaturePolicy','ProductUsageEvent','ReviewEvent','SecurityEvent',
    'SliceDecision','WhatsAppAttachmentImport','BusinessProfile'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN EXECUTE format('GRANT SELECT ON public.%I TO app_admin', t); END IF;
  END LOOP;
  EXECUTE 'GRANT INSERT ON public."PlatformAuditEvent" TO app_admin';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_admin';
  FOREACH t IN ARRAY ARRAY['AccountantBusinessAlert','BillingDocument','BusinessProfile','ContentRun','Conversation','Document','EmailConnection',
    'ExtractionEvidence','ExtractionSnapshot','FinancialRecord','LegalIdentityCorrectionAttachment','LegalIdentityCorrectionRequest',
    'ReviewEvent','SliceDecision','WhatsAppAttachmentImport'] LOOP
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
SELECT 'admin_select=' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('app_admin', c.oid, 'SELECT');
SELECT 'admin_policies=' || count(*) FROM pg_policies WHERE schemaname = 'public' AND 'app_admin' = ANY (roles);
