-- ============================================================================
-- sec-c-530-preflight.sql
--
-- Read-only Production preflight for PR #530, migration
--   20260926110000_sec_c_tenant_composite_fk
-- which adds UNIQUE ("businessId","id") on Customer, Lead, ReplySuggestion and
-- Message, and nine composite (tenant-coherent) foreign keys, each NOT VALID
-- and then validated one by one. A constraint whose existing rows disagree is
-- left NOT VALID by that migration (still enforced for new writes). This file
-- measures, before release, whether any of the nine would be left NOT VALID,
-- and gives the inputs for the estimate of how long ACCESS EXCLUSIVE is held.
--
--   K1-K9   per constraint: (a) child rows whose non-null reference points at a
--           parent of a DIFFERENT businessId; (b) child rows whose non-null
--           reference points at no parent at all. PASS = both 0.
--   S1-S6   row count and pg_total_relation_size of the four parents that get
--           the unique key and of the child tables (INFO).
--   N1      none of the nine constraint names exists yet (PASS = 0).
--   N2      none of the four unique keys (constraint or index name) exists (PASS = 0).
--   V1      server_version_num >= 150000 (ON DEL SET NULL (column) form).
--   W1      policy p7adm_read on WhatsAppAttachmentImport already present (INFO:
--           the #530 block that adds it is guarded, so either value is safe).
--
-- PRIVACY: every result is a count, a size, a version number or a catalog
-- flag. No data row, id, name, phone, email, message text or amount is ever
-- selected; the joins below are aggregated to a single number each.
--
-- HONEST COUNTS: row_security is set off for this transaction. If the session
-- role were subject to row-level security on any table read here, PostgreSQL
-- raises an error instead of silently filtering rows, so a count here can never
-- be an RLS-filtered undercount (ON_ERROR_STOP then ends the run).
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL row_security = off;

WITH
k(ord, check_name, cross_tenant, dangling) AS (
  SELECT 1, 'K1 Conversation_customerId_tenant_fkey (Conversation.customerId -> Customer)',
    (SELECT count(*) FROM "Conversation" c JOIN "Customer" p ON p."id" = c."customerId"
      WHERE c."customerId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Conversation" c
      WHERE c."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" p WHERE p."id" = c."customerId"))
  UNION ALL
  SELECT 2, 'K2 Conversation_leadId_tenant_fkey (Conversation.leadId -> Lead)',
    (SELECT count(*) FROM "Conversation" c JOIN "Lead" p ON p."id" = c."leadId"
      WHERE c."leadId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Conversation" c
      WHERE c."leadId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Lead" p WHERE p."id" = c."leadId"))
  UNION ALL
  SELECT 3, 'K3 Message_customerId_tenant_fkey (Message.customerId -> Customer)',
    (SELECT count(*) FROM "Message" c JOIN "Customer" p ON p."id" = c."customerId"
      WHERE c."customerId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Message" c
      WHERE c."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" p WHERE p."id" = c."customerId"))
  UNION ALL
  SELECT 4, 'K4 Message_generatedFromSuggestionId_tenant_fkey (Message.generatedFromSuggestionId -> ReplySuggestion)',
    (SELECT count(*) FROM "Message" c JOIN "ReplySuggestion" p ON p."id" = c."generatedFromSuggestionId"
      WHERE c."generatedFromSuggestionId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Message" c
      WHERE c."generatedFromSuggestionId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "ReplySuggestion" p WHERE p."id" = c."generatedFromSuggestionId"))
  UNION ALL
  SELECT 5, 'K5 Lead_customerId_tenant_fkey (Lead.customerId -> Customer)',
    (SELECT count(*) FROM "Lead" c JOIN "Customer" p ON p."id" = c."customerId"
      WHERE c."customerId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Lead" c
      WHERE c."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" p WHERE p."id" = c."customerId"))
  UNION ALL
  SELECT 6, 'K6 Appointment_customerId_tenant_fkey (Appointment.customerId -> Customer)',
    (SELECT count(*) FROM "Appointment" c JOIN "Customer" p ON p."id" = c."customerId"
      WHERE c."customerId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Appointment" c
      WHERE c."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" p WHERE p."id" = c."customerId"))
  UNION ALL
  SELECT 7, 'K7 Appointment_leadId_tenant_fkey (Appointment.leadId -> Lead)',
    (SELECT count(*) FROM "Appointment" c JOIN "Lead" p ON p."id" = c."leadId"
      WHERE c."leadId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Appointment" c
      WHERE c."leadId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Lead" p WHERE p."id" = c."leadId"))
  UNION ALL
  SELECT 8, 'K8 Appointment_sourceConversationId_tenant_fkey (Appointment.sourceConversationId -> Conversation)',
    (SELECT count(*) FROM "Appointment" c JOIN "Conversation" p ON p."id" = c."sourceConversationId"
      WHERE c."sourceConversationId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Appointment" c
      WHERE c."sourceConversationId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Conversation" p WHERE p."id" = c."sourceConversationId"))
  UNION ALL
  SELECT 9, 'K9 Appointment_sourceMessageId_tenant_fkey (Appointment.sourceMessageId -> Message)',
    (SELECT count(*) FROM "Appointment" c JOIN "Message" p ON p."id" = c."sourceMessageId"
      WHERE c."sourceMessageId" IS NOT NULL AND p."businessId" <> c."businessId"),
    (SELECT count(*) FROM "Appointment" c
      WHERE c."sourceMessageId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Message" p WHERE p."id" = c."sourceMessageId"))
),
sizes(ord, tbl) AS (
  VALUES (21, 'Customer'), (22, 'Lead'), (23, 'ReplySuggestion'), (24, 'Message'),
         (25, 'Conversation'), (26, 'Appointment')
),
new_fk(conname) AS (
  VALUES ('Conversation_customerId_tenant_fkey'), ('Conversation_leadId_tenant_fkey'),
         ('Message_customerId_tenant_fkey'), ('Message_generatedFromSuggestionId_tenant_fkey'),
         ('Lead_customerId_tenant_fkey'), ('Appointment_customerId_tenant_fkey'),
         ('Appointment_leadId_tenant_fkey'), ('Appointment_sourceConversationId_tenant_fkey'),
         ('Appointment_sourceMessageId_tenant_fkey')
),
new_uq(name) AS (
  VALUES ('Customer_businessId_id_key'), ('Lead_businessId_id_key'),
         ('ReplySuggestion_businessId_id_key'), ('Message_businessId_id_key')
),
report(ord, check_name, cross_tenant, dangling, row_count, total_bytes, result) AS (
  SELECT ord, check_name, cross_tenant, dangling, NULL::bigint, NULL::bigint,
         CASE WHEN cross_tenant = 0 AND dangling = 0 THEN 'PASS' ELSE 'FAIL' END
  FROM k
  UNION ALL
  SELECT s.ord,
         'S' || (s.ord - 20) || ' size of ' || s.tbl || ' (rows, pg_total_relation_size bytes)',
         NULL, NULL,
         CASE s.tbl
           WHEN 'Customer'        THEN (SELECT count(*) FROM "Customer")
           WHEN 'Lead'            THEN (SELECT count(*) FROM "Lead")
           WHEN 'ReplySuggestion' THEN (SELECT count(*) FROM "ReplySuggestion")
           WHEN 'Message'         THEN (SELECT count(*) FROM "Message")
           WHEN 'Conversation'    THEN (SELECT count(*) FROM "Conversation")
           WHEN 'Appointment'     THEN (SELECT count(*) FROM "Appointment")
         END,
         pg_total_relation_size(format('public.%I', s.tbl)::regclass),
         'INFO'
  FROM sizes s
  UNION ALL
  SELECT 31, 'N1 none of the nine #530 constraint names exists yet (count in row_count)',
         NULL, NULL, (SELECT count(*) FROM pg_constraint k JOIN new_fk f ON f.conname = k.conname), NULL,
         CASE WHEN (SELECT count(*) FROM pg_constraint k JOIN new_fk f ON f.conname = k.conname) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 32, 'N2 none of the four #530 unique keys exists yet as constraint or index (count in row_count)',
         NULL, NULL,
         (SELECT count(*) FROM new_uq u
           WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = u.name)
              OR EXISTS (SELECT 1 FROM pg_class ic WHERE ic.relname = u.name)), NULL,
         CASE WHEN (SELECT count(*) FROM new_uq u
                     WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = u.name)
                        OR EXISTS (SELECT 1 FROM pg_class ic WHERE ic.relname = u.name)) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 33, 'V1 server_version_num >= 150000 (value in row_count)',
         NULL, NULL, current_setting('server_version_num')::bigint, NULL,
         CASE WHEN current_setting('server_version_num')::int >= 150000 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 34, 'W1 policy p7adm_read already on WhatsAppAttachmentImport (count in row_count; guarded in #530, either is safe)',
         NULL, NULL,
         (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           WHERE c.relname = 'WhatsAppAttachmentImport' AND pol.polname = 'p7adm_read'),
         NULL, 'INFO'
)
SELECT ord, check_name, result, cross_tenant, dangling, row_count, total_bytes
FROM report
ORDER BY ord;

ROLLBACK;
