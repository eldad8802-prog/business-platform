-- sec(C) / M-3 — tenant-coherent foreign keys for the highest-risk relations.
--
-- EXPAND-ONLY. Adds UNIQUE ("businessId","id") on four parents and nine composite
-- foreign keys. Drops nothing, rewrites no row, changes no column, and leaves every
-- existing single-column foreign key exactly as it is.
--
-- WHY
-- PostgreSQL checks a foreign key WITHOUT row-level security: the RI query runs as
-- the table owner and sees every tenant's rows. With a single-column FK such as
-- "Conversation"."customerId" -> "Customer"."id", a runtime that is NOSUPERUSER /
-- NOBYPASSRLS and inside tenant A's GUC can still store tenant B's customer id —
-- RLS decides which rows a statement READS, not which ids an FK ACCEPTS. The app
-- layer now checks ownership in the same tenant transaction (#518 + sec(C)); these
-- constraints make the database refuse the same thing on its own: a child row may
-- only point at a parent with the SAME "businessId". Violation = SQLSTATE 23503 on
-- the "*_tenant_fkey" constraint.
--
-- DELETE SEMANTICS ARE UNCHANGED. Each composite FK uses
-- ON DELETE SET NULL ("<fk column>") — PostgreSQL 15+ column-list form — so a
-- parent delete nulls ONLY the reference, exactly what the existing single-column
-- FK already does. (Plain SET NULL would null "businessId" too — never acceptable.)
-- MATCH SIMPLE (default): a NULL reference is not checked, as today.
--
-- VALIDATION. Constraints are added NOT VALID (enforced for every new INSERT/UPDATE
-- immediately, no full scan under lock), then VALIDATEd one by one. If legacy data
-- already holds a cross-tenant link, VALIDATE raises 23503; that is caught, reported
-- as a WARNING naming the constraint (no row data), and the constraint stays NOT
-- VALID — still enforcing new writes — instead of failing the release. The catalog
-- evidence (ops/evidence/security-catalog-assert.sql) reports any constraint left
-- NOT VALID as FAIL, which is the owner's signal to investigate legacy rows.
-- Production data has NOT been checked against these constraints (unproven).
--
-- LOCKS. ADD CONSTRAINT UNIQUE builds an index under an ACCESS EXCLUSIVE lock on
-- Customer, Lead, ReplySuggestion and Message for the duration of the build.
--
-- PRISMA. These constraints are database-only (schema.prisma is untouched, so no
-- client or query changes). A future `prisma migrate dev` diff would propose
-- dropping them; do not accept that hunk.

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'sec_c_tenant_composite_fk requires PostgreSQL 15+ (ON DELETE SET NULL (column))';
  END IF;
END
$$;

-- 1. Parent keys a composite FK can reference. ("Conversation" already carries
--    UNIQUE ("id","businessId") from the Message composite FK.)
ALTER TABLE "Customer"        ADD CONSTRAINT "Customer_businessId_id_key"        UNIQUE ("businessId", "id");
ALTER TABLE "Lead"            ADD CONSTRAINT "Lead_businessId_id_key"            UNIQUE ("businessId", "id");
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_businessId_id_key" UNIQUE ("businessId", "id");
ALTER TABLE "Message"         ADD CONSTRAINT "Message_businessId_id_key"         UNIQUE ("businessId", "id");

-- 2. Composite (tenant-coherent) foreign keys, NOT VALID.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Message" ADD CONSTRAINT "Message_generatedFromSuggestionId_tenant_fkey"
  FOREIGN KEY ("businessId", "generatedFromSuggestionId") REFERENCES "ReplySuggestion"("businessId", "id")
  ON DELETE SET NULL ("generatedFromSuggestionId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_sourceConversationId_tenant_fkey"
  FOREIGN KEY ("sourceConversationId", "businessId") REFERENCES "Conversation"("id", "businessId")
  ON DELETE SET NULL ("sourceConversationId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_sourceMessageId_tenant_fkey"
  FOREIGN KEY ("businessId", "sourceMessageId") REFERENCES "Message"("businessId", "id")
  ON DELETE SET NULL ("sourceMessageId") ON UPDATE NO ACTION NOT VALID;

-- 3. Validate each one; a legacy violation leaves that constraint NOT VALID
--    (still enforcing new writes) instead of failing the release.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'f' AND NOT convalidated
       AND conname IN (
         'Conversation_customerId_tenant_fkey', 'Conversation_leadId_tenant_fkey',
         'Message_customerId_tenant_fkey', 'Message_generatedFromSuggestionId_tenant_fkey',
         'Lead_customerId_tenant_fkey', 'Appointment_customerId_tenant_fkey',
         'Appointment_leadId_tenant_fkey', 'Appointment_sourceConversationId_tenant_fkey',
         'Appointment_sourceMessageId_tenant_fkey')
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.conname);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'sec_c: % left NOT VALID — existing rows link across tenants (enforced for new writes)', c.conname;
    END;
  END LOOP;
END
$$;
