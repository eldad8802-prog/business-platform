-- SEC-F (security closure, workstream F) — append-only audit trails with a
-- keyed chain, fiscal immutability at the database, and a SecurityEvent store.
--
-- EXPAND-ONLY with respect to the application on main: every column added is
-- nullable, the one table added is new, and nothing the application does today
-- is refused. Verified by enumerating every write site (see the PR body):
--
--   * no code path UPDATEs, DELETEs or TRUNCATEs BillingAuditEvent,
--     PaymentAuditEvent or PayablesAuditEvent;
--   * every BillingDocument UPDATE on an ISSUED row touches only the PDF /
--     signed-PDF operational columns, or sets the authority projection
--     (allocationNumber, allocationApprovedAt, isEmergencyAllocation) exactly
--     once; nothing deletes an ISSUED document;
--   * lines, receipt payments and receipt allocations are only written while
--     their document is DRAFT or PENDING_REVIEW (issuance happens last).
--
-- WHY TRIGGERS AS WELL AS PRIVILEGES
--
-- The REVOKEs make the runtime identities unable to rewrite history (42501).
-- They do nothing against an identity that owns the table, and this project's
-- migration owner is also the identity that runs maintenance. A BEFORE trigger
-- is enforced for the owner too, so a rewrite must first be an explicit,
-- visible DDL act (DROP/DISABLE TRIGGER) rather than one UPDATE. The keyed
-- chain (chainSeq/prevHash/chainHash, HMAC-SHA256 with a server key the
-- database never holds) is what detects a rewrite that went through anyway.
--
-- SQLSTATEs raised here (class DZ is unused by PostgreSQL):
--   DZ001  AUDIT_APPEND_ONLY     UPDATE/DELETE/TRUNCATE of an append-only row
--   DZ002  AUDIT_CHAIN_LINK      a chained insert that does not extend the head
--   DZ010  FISCAL_IMMUTABLE      change to a frozen column / child of an ISSUED doc
--
-- Role statements are guarded, as in every other migration: with none of the
-- roles present this is still a successful apply.

-- ============================================================================
-- 1. Chain columns on the three audit trails (nullable; legacy rows stay NULL)
-- ============================================================================

ALTER TABLE "BillingAuditEvent"  ADD COLUMN IF NOT EXISTS "chainSeq"   INTEGER;
ALTER TABLE "BillingAuditEvent"  ADD COLUMN IF NOT EXISTS "prevHash"   TEXT;
ALTER TABLE "BillingAuditEvent"  ADD COLUMN IF NOT EXISTS "chainHash"  TEXT;
ALTER TABLE "BillingAuditEvent"  ADD COLUMN IF NOT EXISTS "chainKeyId" TEXT;

ALTER TABLE "PaymentAuditEvent"  ADD COLUMN IF NOT EXISTS "chainSeq"   INTEGER;
ALTER TABLE "PaymentAuditEvent"  ADD COLUMN IF NOT EXISTS "prevHash"   TEXT;
ALTER TABLE "PaymentAuditEvent"  ADD COLUMN IF NOT EXISTS "chainHash"  TEXT;
ALTER TABLE "PaymentAuditEvent"  ADD COLUMN IF NOT EXISTS "chainKeyId" TEXT;

ALTER TABLE "PayablesAuditEvent" ADD COLUMN IF NOT EXISTS "chainSeq"   INTEGER;
ALTER TABLE "PayablesAuditEvent" ADD COLUMN IF NOT EXISTS "prevHash"   TEXT;
ALTER TABLE "PayablesAuditEvent" ADD COLUMN IF NOT EXISTS "chainHash"  TEXT;
ALTER TABLE "PayablesAuditEvent" ADD COLUMN IF NOT EXISTS "chainKeyId" TEXT;

-- All four chain columns are present together or absent together.
ALTER TABLE "BillingAuditEvent" DROP CONSTRAINT IF EXISTS "BillingAuditEvent_chain_shape_chk";
ALTER TABLE "BillingAuditEvent" ADD CONSTRAINT "BillingAuditEvent_chain_shape_chk" CHECK (
  ("chainSeq" IS NULL AND "prevHash" IS NULL AND "chainHash" IS NULL AND "chainKeyId" IS NULL)
  OR ("chainSeq" >= 1 AND "prevHash" IS NOT NULL AND "chainKeyId" IS NOT NULL
      AND "chainHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "PaymentAuditEvent" DROP CONSTRAINT IF EXISTS "PaymentAuditEvent_chain_shape_chk";
ALTER TABLE "PaymentAuditEvent" ADD CONSTRAINT "PaymentAuditEvent_chain_shape_chk" CHECK (
  ("chainSeq" IS NULL AND "prevHash" IS NULL AND "chainHash" IS NULL AND "chainKeyId" IS NULL)
  OR ("chainSeq" >= 1 AND "prevHash" IS NOT NULL AND "chainKeyId" IS NOT NULL
      AND "chainHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "PayablesAuditEvent" DROP CONSTRAINT IF EXISTS "PayablesAuditEvent_chain_shape_chk";
ALTER TABLE "PayablesAuditEvent" ADD CONSTRAINT "PayablesAuditEvent_chain_shape_chk" CHECK (
  ("chainSeq" IS NULL AND "prevHash" IS NULL AND "chainHash" IS NULL AND "chainKeyId" IS NULL)
  OR ("chainSeq" >= 1 AND "prevHash" IS NOT NULL AND "chainKeyId" IS NOT NULL
      AND "chainHash" ~ '^[0-9a-f]{64}$')
);

-- One chain per business per table: a sequence number is never reused.
CREATE UNIQUE INDEX IF NOT EXISTS "BillingAuditEvent_businessId_chainSeq_key"
  ON "BillingAuditEvent"("businessId", "chainSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAuditEvent_businessId_chainSeq_key"
  ON "PaymentAuditEvent"("businessId", "chainSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "PayablesAuditEvent_businessId_chainSeq_key"
  ON "PayablesAuditEvent"("businessId", "chainSeq");

-- ============================================================================
-- 2. Trigger functions
-- ============================================================================

-- 2a. Append-only. Fires for every role, table owner included.
CREATE OR REPLACE FUNCTION public.secf_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'DZ001',
    MESSAGE = format('AUDIT_APPEND_ONLY: %s on %I is refused; the table is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;

-- 2b. Chain linkage. The database cannot compute the MAC (it never holds the
-- key) but it can refuse a chained row that does not extend the current head:
-- sequence N+1 must name sequence N's chainHash as its prevHash, and sequence 1
-- must name 'GENESIS'. With the (businessId, chainSeq) unique index this keeps
-- every chain linear at write time. Unchained rows (chainSeq NULL) are still
-- accepted: legacy writers and the payments trail until it adopts the chain.
-- The verifier reports an unchained row that follows a chain start.
CREATE OR REPLACE FUNCTION public.secf_audit_chain_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  pred_hash text;
BEGIN
  IF NEW."chainSeq" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."chainSeq" = 1 THEN
    IF NEW."prevHash" IS DISTINCT FROM 'GENESIS' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZ002',
        MESSAGE = format('AUDIT_CHAIN_LINK: %I chain start for business %s must name GENESIS', TG_TABLE_NAME, NEW."businessId");
    END IF;
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "chainHash" FROM public.%I WHERE "businessId" = $1 AND "chainSeq" = $2', TG_TABLE_NAME)
    INTO pred_hash
    USING NEW."businessId", NEW."chainSeq" - 1;
  IF pred_hash IS NULL OR pred_hash IS DISTINCT FROM NEW."prevHash" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZ002',
      MESSAGE = format('AUDIT_CHAIN_LINK: %I seq %s for business %s does not extend the chain head', TG_TABLE_NAME, NEW."chainSeq", NEW."businessId");
  END IF;
  RETURN NEW;
END
$fn$;

-- 2c. BillingDocument: once ISSUED, only the operational PDF columns may
-- change, the authority projection may be set exactly once, and a QUOTE may
-- receive its number and its conversion link exactly once. Everything else —
-- status, type, numbers, dates, customer, totals, snapshot, hash, references,
-- tenant — is frozen. An ISSUED document is never deleted.
CREATE OR REPLACE FUNCTION public.secf_billing_document_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  mutable_cols text[] := ARRAY[
    'updatedAt',
    'pdfRenderStatus', 'pdfTemplateVersion', 'pdfStorageKey', 'pdfHash',
    'pdfRenderedAt', 'pdfRenderError',
    'signedPdfStorageKey', 'signedPdfHash', 'signedAt'
  ];
  o jsonb;
  n jsonb;
  changed text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text = 'ISSUED' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZ010',
        MESSAGE = format('FISCAL_IMMUTABLE: issued BillingDocument %s cannot be deleted', OLD."id");
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status"::text <> 'ISSUED' THEN
    RETURN NEW;
  END IF;

  IF OLD."allocationNumber" IS NULL AND NEW."allocationNumber" IS NOT NULL THEN
    mutable_cols := mutable_cols || ARRAY['allocationNumber', 'allocationApprovedAt', 'isEmergencyAllocation'];
  END IF;
  IF OLD."documentType"::text = 'QUOTE' THEN
    IF OLD."documentNumber" IS NULL THEN
      mutable_cols := mutable_cols || ARRAY['documentNumber', 'documentNumberFormatted'];
    END IF;
    IF OLD."convertedToInvoiceId" IS NULL THEN
      mutable_cols := mutable_cols || ARRAY['convertedToInvoiceId'];
    END IF;
  END IF;

  o := to_jsonb(OLD) - mutable_cols;
  n := to_jsonb(NEW) - mutable_cols;
  IF o IS DISTINCT FROM n THEN
    SELECT string_agg(k, ',' ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) AS k
     WHERE (o -> k) IS DISTINCT FROM (n -> k);
    RAISE EXCEPTION USING
      ERRCODE = 'DZ010',
      MESSAGE = format('FISCAL_IMMUTABLE: issued BillingDocument %s column(s) %s are frozen', OLD."id", changed);
  END IF;
  RETURN NEW;
END
$fn$;

-- 2d. Children of a document (lines, receipt payments, receipt allocations):
-- no INSERT, UPDATE or DELETE while the owning document is ISSUED.
-- TG_ARGV[0] names the column that points at the owning document. A parent the
-- caller cannot see is left to RLS and the foreign key to decide, so this guard
-- never changes the error class of a cross-tenant attempt; and a parent that no
-- longer exists (the cascade of a DRAFT delete) was, by 2c, not ISSUED.
CREATE OR REPLACE FUNCTION public.secf_billing_child_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  parent_col text := TG_ARGV[0];
  ids integer[] := ARRAY[]::integer[];
  pid integer;
  st text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    ids := ids || ((to_jsonb(OLD) ->> parent_col)::integer);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    ids := ids || ((to_jsonb(NEW) ->> parent_col)::integer);
  END IF;
  FOREACH pid IN ARRAY ids LOOP
    SELECT d."status"::text INTO st FROM public."BillingDocument" d WHERE d."id" = pid;
    IF st = 'ISSUED' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZ010',
        MESSAGE = format('FISCAL_IMMUTABLE: %s on %I refused; BillingDocument %s is issued', TG_OP, TG_TABLE_NAME, pid);
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

-- 2e. TRUNCATE bypasses row triggers, so it is refused outright on every
-- guarded table.
CREATE OR REPLACE FUNCTION public.secf_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = CASE WHEN TG_ARGV[0] = 'fiscal' THEN 'DZ010' ELSE 'DZ001' END,
    MESSAGE = format('%s: TRUNCATE on %I is refused',
                     CASE WHEN TG_ARGV[0] = 'fiscal' THEN 'FISCAL_IMMUTABLE' ELSE 'AUDIT_APPEND_ONLY' END,
                     TG_TABLE_NAME);
END
$fn$;

-- The trigger functions are only ever invoked by their triggers.
REVOKE ALL ON FUNCTION public.secf_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.secf_audit_chain_link_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.secf_billing_document_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.secf_billing_child_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.secf_truncate_guard() FROM PUBLIC;

-- ============================================================================
-- 3. Audit trails: triggers
-- ============================================================================

DROP TRIGGER IF EXISTS secf_append_only ON "BillingAuditEvent";
CREATE TRIGGER secf_append_only BEFORE UPDATE OR DELETE ON "BillingAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_append_only_guard();
DROP TRIGGER IF EXISTS secf_no_truncate ON "BillingAuditEvent";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "BillingAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('audit');
DROP TRIGGER IF EXISTS secf_chain_link ON "BillingAuditEvent";
CREATE TRIGGER secf_chain_link BEFORE INSERT ON "BillingAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_audit_chain_link_guard();

DROP TRIGGER IF EXISTS secf_append_only ON "PaymentAuditEvent";
CREATE TRIGGER secf_append_only BEFORE UPDATE OR DELETE ON "PaymentAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_append_only_guard();
DROP TRIGGER IF EXISTS secf_no_truncate ON "PaymentAuditEvent";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "PaymentAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('audit');
DROP TRIGGER IF EXISTS secf_chain_link ON "PaymentAuditEvent";
CREATE TRIGGER secf_chain_link BEFORE INSERT ON "PaymentAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_audit_chain_link_guard();

DROP TRIGGER IF EXISTS secf_append_only ON "PayablesAuditEvent";
CREATE TRIGGER secf_append_only BEFORE UPDATE OR DELETE ON "PayablesAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_append_only_guard();
DROP TRIGGER IF EXISTS secf_no_truncate ON "PayablesAuditEvent";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "PayablesAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('audit');
DROP TRIGGER IF EXISTS secf_chain_link ON "PayablesAuditEvent";
CREATE TRIGGER secf_chain_link BEFORE INSERT ON "PayablesAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_audit_chain_link_guard();

-- ============================================================================
-- 4. Audit trails: tenant access becomes read + append only
--
-- Each FOR ALL tenant rule is re-created under the SAME name as a FOR SELECT
-- rule (so every battery that counts rules by name still counts the same),
-- plus a FOR INSERT rule with the identical tenant predicate, plus RESTRICTIVE
-- UPDATE and DELETE denials that AND with anything added later.
-- ============================================================================

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuditEvent";
CREATE POLICY p7w4eb2_tenant ON "BillingAuditEvent"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_insert ON "BillingAuditEvent";
CREATE POLICY secf_audit_insert ON "BillingAuditEvent"
  FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_no_update ON "BillingAuditEvent";
CREATE POLICY secf_audit_no_update ON "BillingAuditEvent"
  AS RESTRICTIVE FOR UPDATE
  USING (false);
DROP POLICY IF EXISTS secf_audit_no_delete ON "BillingAuditEvent";
CREATE POLICY secf_audit_no_delete ON "BillingAuditEvent"
  AS RESTRICTIVE FOR DELETE
  USING (false);

DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentAuditEvent";
CREATE POLICY p7w4ea_tenant ON "PaymentAuditEvent"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_insert ON "PaymentAuditEvent";
CREATE POLICY secf_audit_insert ON "PaymentAuditEvent"
  FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_no_update ON "PaymentAuditEvent";
CREATE POLICY secf_audit_no_update ON "PaymentAuditEvent"
  AS RESTRICTIVE FOR UPDATE
  USING (false);
DROP POLICY IF EXISTS secf_audit_no_delete ON "PaymentAuditEvent";
CREATE POLICY secf_audit_no_delete ON "PaymentAuditEvent"
  AS RESTRICTIVE FOR DELETE
  USING (false);

DROP POLICY IF EXISTS payables_p1a_tenant ON "PayablesAuditEvent";
CREATE POLICY payables_p1a_tenant ON "PayablesAuditEvent"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_insert ON "PayablesAuditEvent";
CREATE POLICY secf_audit_insert ON "PayablesAuditEvent"
  FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS secf_audit_no_update ON "PayablesAuditEvent";
CREATE POLICY secf_audit_no_update ON "PayablesAuditEvent"
  AS RESTRICTIVE FOR UPDATE
  USING (false);
DROP POLICY IF EXISTS secf_audit_no_delete ON "PayablesAuditEvent";
CREATE POLICY secf_audit_no_delete ON "PayablesAuditEvent"
  AS RESTRICTIVE FOR DELETE
  USING (false);

-- ============================================================================
-- 5. PayablesAuditEvent: the audit trail must survive its tenant.
--
-- It was ON DELETE CASCADE from Business, so deleting a business silently
-- deleted its payables history. Account erasure never deletes a Business (it
-- stamps deletedAt) and classifies this table RETAIN (SECURITY/AUDIT), so
-- RESTRICT changes nothing the product does; it turns the one path that would
-- have erased the trail into an explicit error. BillingAuditEvent and
-- PaymentAuditEvent are already RESTRICT.
-- ============================================================================

ALTER TABLE "PayablesAuditEvent" DROP CONSTRAINT IF EXISTS "PayablesAuditEvent_businessId_fkey";
ALTER TABLE "PayablesAuditEvent" ADD CONSTRAINT "PayablesAuditEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 6. Fiscal immutability triggers
-- ============================================================================

DROP TRIGGER IF EXISTS secf_fiscal_immutable ON "BillingDocument";
CREATE TRIGGER secf_fiscal_immutable BEFORE UPDATE OR DELETE ON "BillingDocument"
  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_document_immutable();
DROP TRIGGER IF EXISTS secf_no_truncate ON "BillingDocument";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "BillingDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('fiscal');

DROP TRIGGER IF EXISTS secf_fiscal_immutable ON "BillingDocumentLine";
CREATE TRIGGER secf_fiscal_immutable BEFORE INSERT OR UPDATE OR DELETE ON "BillingDocumentLine"
  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_child_immutable('billingDocumentId');
DROP TRIGGER IF EXISTS secf_no_truncate ON "BillingDocumentLine";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "BillingDocumentLine"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('fiscal');

DROP TRIGGER IF EXISTS secf_fiscal_immutable ON "BillingReceiptPayment";
CREATE TRIGGER secf_fiscal_immutable BEFORE INSERT OR UPDATE OR DELETE ON "BillingReceiptPayment"
  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_child_immutable('billingDocumentId');
DROP TRIGGER IF EXISTS secf_no_truncate ON "BillingReceiptPayment";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "BillingReceiptPayment"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('fiscal');

DROP TRIGGER IF EXISTS secf_fiscal_immutable ON "BillingPaymentAllocation";
CREATE TRIGGER secf_fiscal_immutable BEFORE INSERT OR UPDATE OR DELETE ON "BillingPaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_child_immutable('receiptDocumentId');
DROP TRIGGER IF EXISTS secf_no_truncate ON "BillingPaymentAllocation";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "BillingPaymentAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('fiscal');

-- ============================================================================
-- 7. SecurityEvent — durable, PII-minimised security event store
--
-- No foreign keys on purpose: an event about a login attempt must be writable
-- before any tenant is known, must survive the rows it mentions, and must not
-- make account erasure depend on it. userId/businessId are bare integers.
-- The payload is bounded; the application writes only hashed/truncated
-- network identifiers and never tokens, passwords or email addresses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eventType"   TEXT NOT NULL,
  "outcome"     TEXT NOT NULL,
  "reasonClass" TEXT,
  "businessId"  INTEGER,
  "userId"      INTEGER,
  "actorKind"   TEXT NOT NULL DEFAULT 'USER',
  "ipHash"      TEXT,
  "route"       TEXT,
  "metadata"    JSONB,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- Shape constraints are separate statements so they land even where the table
-- already exists (idempotent re-apply; a lab built from schema.prisma).
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_eventType_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_eventType_chk"
  CHECK ("eventType" ~ '^[A-Z][A-Z0-9_]{2,63}$');
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_outcome_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_outcome_chk"
  CHECK ("outcome" IN ('SUCCESS', 'FAILURE', 'DENIED', 'INFO'));
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_reasonClass_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_reasonClass_chk"
  CHECK ("reasonClass" IS NULL OR "reasonClass" ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_actorKind_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_actorKind_chk"
  CHECK ("actorKind" IN ('USER', 'PLATFORM_ADMIN', 'SYSTEM', 'ANONYMOUS'));
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_ipHash_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_ipHash_chk"
  CHECK ("ipHash" IS NULL OR "ipHash" ~ '^[0-9a-f]{16,64}$');
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_route_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_route_chk"
  CHECK ("route" IS NULL OR length("route") <= 128);
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_metadata_chk";
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_metadata_chk"
  CHECK ("metadata" IS NULL OR (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 8192));

CREATE INDEX IF NOT EXISTS "SecurityEvent_occurredAt_idx" ON "SecurityEvent"("occurredAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_businessId_occurredAt_idx" ON "SecurityEvent"("businessId", "occurredAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_userId_occurredAt_idx" ON "SecurityEvent"("userId", "occurredAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_eventType_occurredAt_idx" ON "SecurityEvent"("eventType", "occurredAt");

ALTER TABLE "SecurityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SecurityEvent" FORCE ROW LEVEL SECURITY;

-- Append: an event may name no business (pre-authentication) or the business
-- of the current tenant context — never another tenant's.
DROP POLICY IF EXISTS secf_security_event_insert ON "SecurityEvent";
CREATE POLICY secf_security_event_insert ON "SecurityEvent"
  FOR INSERT
  WITH CHECK ("businessId" IS NULL
              OR "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
-- Read: platform admin only. No tenant read rule exists, so a tenant context
-- reads nothing even if it were ever granted SELECT.
DROP POLICY IF EXISTS secf_security_event_admin_read ON "SecurityEvent";
CREATE POLICY secf_security_event_admin_read ON "SecurityEvent"
  FOR SELECT TO app_admin
  USING (true);
DROP POLICY IF EXISTS secf_audit_no_update ON "SecurityEvent";
CREATE POLICY secf_audit_no_update ON "SecurityEvent"
  AS RESTRICTIVE FOR UPDATE
  USING (false);
DROP POLICY IF EXISTS secf_audit_no_delete ON "SecurityEvent";
CREATE POLICY secf_audit_no_delete ON "SecurityEvent"
  AS RESTRICTIVE FOR DELETE
  USING (false);

DROP TRIGGER IF EXISTS secf_append_only ON "SecurityEvent";
CREATE TRIGGER secf_append_only BEFORE UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION public.secf_append_only_guard();
DROP TRIGGER IF EXISTS secf_no_truncate ON "SecurityEvent";
CREATE TRIGGER secf_no_truncate BEFORE TRUNCATE ON "SecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.secf_truncate_guard('audit');

-- ============================================================================
-- 8. Privileges (guarded; NOLOGIN group roles only, never a login identity)
--
-- This project's databases carry ALTER DEFAULT PRIVILEGES granting app_runtime
-- a,r,w,d on every NEW table (see 20260924180000), so SecurityEvent arrives
-- over-granted; it is normalised to zero first and then granted exactly.
-- ============================================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "BillingAuditEvent"  FROM app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PaymentAuditEvent"  FROM app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PayablesAuditEvent" FROM app_runtime;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SecurityEvent" FROM app_runtime;
    GRANT INSERT ON "SecurityEvent" TO app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "BillingAuditEvent"  FROM app_auth;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PaymentAuditEvent"  FROM app_auth;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PayablesAuditEvent" FROM app_auth;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SecurityEvent" FROM app_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "BillingAuditEvent"  FROM app_admin;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PaymentAuditEvent"  FROM app_admin;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PayablesAuditEvent" FROM app_admin;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SecurityEvent" FROM app_admin;
    GRANT SELECT ON "SecurityEvent" TO app_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "BillingAuditEvent"  FROM app_ctlplane;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PaymentAuditEvent"  FROM app_ctlplane;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PayablesAuditEvent" FROM app_ctlplane;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SecurityEvent" FROM app_ctlplane;
  END IF;
END
$do$;
