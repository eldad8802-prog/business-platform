-- ============================================================================================================
-- 20261126090000_service_desk_case_charge — Service Desk: what a service case is charged, and which billing documents
-- belong to it. DRAFT — never applied without the owner's separate approval. Order: after 20261123090000 (#1061) and
-- 20261125090000 (#1096).
--
-- Owner decisions 2026-11-11: a tax invoice is not a precondition of a handover; the absence of a document is never
-- "no debt"; exempt dealers, paid service and free service are all supported; a later change of the charge is a new,
-- reasoned, journaled record — never a silent edit; billing is not changed (no column, no foreign key, no trigger on
-- any billing table — the link lives here and only READS billing rows).
--
--   "ServiceCaseCharge"       the charge history of a case, append-only: seq 1, 2, … — the current charge is the last.
--                             CHARGEABLE (a positive amount in agorot, ILS; from an approved quote or entered by the
--                             owner) or NO_CHARGE (free of charge, with a documented reason). Every change after the
--                             first carries a reason, unless it is the approval of a quote (the quote is the record).
--   "ServiceCaseBillingLink"  which billing documents belong to a case (the billing session's read contract, #1102):
--                               CHARGE              a TAX_INVOICE or a TAX_INVOICE_RECEIPT — at most ONE case at a time
--                               STANDALONE_PAYMENT  an ISSUED RECEIPT (e.g. an exempt dealer's), linked by the owner
--                                                   explicitly — at most ONE case at a time; only the part billing
--                                                   attributes to no invoice is credited (owner decision 2026-11-11)
--                               AFTER_SALE_CREDIT   an ISSUED credit note, as the record of a T7 (return / exchange)
--                                                   case resolved by a credit; evidence only — it never enters the
--                                                   case balance (it refunds the original sale, not this service)
--                             A receipt allocated to invoices is never linked: its money reaches a case only through
--                             the outstanding of the case's invoices (no double count). Credits come with their invoice.
--                             An unlink happens once, with who and why; the row stays (history). A document's status
--                             is NOT frozen here: the balance reader evaluates it (draft / foreign currency / missing →
--                             the balance is UNKNOWN and the handover stays blocked).
--
-- Unchanged: every existing table, row, constraint, policy, grant and function. Billing tables are only read by the
-- link guard (as the caller, under RLS).
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CHARGE: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceQuote"') IS NULL
     OR to_regclass('public."BillingDocument"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_CHARGE: the Service Desk foundation or the billing documents are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceQuote_businessId_caseId_version_key') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CHARGE: a composite key this migration references is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL
     OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_CHARGE: the Service Desk trigger functions are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CHARGE: the P4 audit journal (20261122090000) is not applied; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceChargeMode" AS ENUM ('CHARGEABLE', 'NO_CHARGE');
CREATE TYPE "ServiceChargeSource" AS ENUM ('APPROVED_QUOTE', 'OWNER_ENTERED');
CREATE TYPE "ServiceBillingLinkRole" AS ENUM ('CHARGE', 'STANDALONE_PAYMENT', 'AFTER_SALE_CREDIT');

-- The case journal (ServiceCaseEvent) gains three STATUS-PRESERVING records, as P4 did: a charge recorded by the owner,
-- a billing document linked, one unlinked. Each bumps the case version and leaves status / hold / cancel request as they
-- were (service_event_matches_case already demands it); the payload stays closed (tokens, numbers, booleans — the
-- reasons live in their own columns). A quote approval writes its charge record under its own quote.approved event.
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'charge.recorded';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'billing.linked';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'billing.unlinked';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RECORD_CHARGE';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'LINK_BILLING_DOCUMENT';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'UNLINK_BILLING_DOCUMENT';
-- compared as text: the new enum values are not used before this transaction ends
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_charge_in_place" CHECK (
      ("action"::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT'))
    = ("eventType"::text IN ('charge.recorded', 'billing.linked', 'billing.unlinked'))
  AND ("action"::text <> 'RECORD_CHARGE' OR "eventType"::text = 'charge.recorded')
  AND ("action"::text <> 'LINK_BILLING_DOCUMENT' OR "eventType"::text = 'billing.linked')
  AND ("action"::text <> 'UNLINK_BILLING_DOCUMENT' OR "eventType"::text = 'billing.unlinked')
  AND ("action"::text NOT IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT') OR (
            "fromStatus" = "toStatus"
        AND "holdReasonBefore" IS NOT DISTINCT FROM "holdReasonAfter"
        AND "cancellationRequestedBefore" = "cancellationRequestedAfter"
        AND "actor" = 'OWNER_USER')));

-- ── 2. Tables ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceCaseCharge" (
  "id"           SERIAL NOT NULL,
  "businessId"   INTEGER NOT NULL,
  "caseId"       INTEGER NOT NULL,
  "seq"          INTEGER NOT NULL,
  "mode"         "ServiceChargeMode" NOT NULL,
  "amountAgorot" INTEGER,
  "currency"     CHAR(3) NOT NULL DEFAULT 'ILS',
  "source"       "ServiceChargeSource",
  "quoteVersion" INTEGER,
  "reason"       TEXT,
  "actor"        "ServiceActor" NOT NULL,
  "actorUserId"  INTEGER,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"     TIMESTAMP(3),
  CONSTRAINT "ServiceCaseCharge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseCharge_seq" CHECK ("seq" >= 1),
  CONSTRAINT "ServiceCaseCharge_currency" CHECK ("currency" = 'ILS'),
  CONSTRAINT "ServiceCaseCharge_mode" CHECK (
    ("mode" = 'CHARGEABLE' AND "amountAgorot" > 0 AND "source" IS NOT NULL)
    OR ("mode" = 'NO_CHARGE' AND "amountAgorot" IS NULL AND "source" IS NULL AND "quoteVersion" IS NULL)),
  CONSTRAINT "ServiceCaseCharge_quote" CHECK (("source" = 'APPROVED_QUOTE') = ("quoteVersion" IS NOT NULL)),
  CONSTRAINT "ServiceCaseCharge_reason_text" CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 1000),
  -- free of charge always has its reason; a change after the first record has one too, unless it is a quote approval
  CONSTRAINT "ServiceCaseCharge_reason_required" CHECK (
    "erasedAt" IS NOT NULL OR "reason" IS NOT NULL OR ("mode" = 'CHARGEABLE' AND ("seq" = 1 OR "source" = 'APPROVED_QUOTE'))),
  CONSTRAINT "ServiceCaseCharge_actor" CHECK ("actor" <> 'OWNER_USER' OR "actorUserId" IS NOT NULL OR "erasedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "ServiceCaseCharge_businessId_id_key" ON "ServiceCaseCharge"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCaseCharge_businessId_caseId_seq_key" ON "ServiceCaseCharge"("businessId", "caseId", "seq");
ALTER TABLE "ServiceCaseCharge" ADD CONSTRAINT "ServiceCaseCharge_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseCharge" ADD CONSTRAINT "ServiceCaseCharge_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCaseCharge" ADD CONSTRAINT "ServiceCaseCharge_quote_fkey"
  FOREIGN KEY ("businessId", "caseId", "quoteVersion") REFERENCES "ServiceQuote"("businessId", "caseId", "version") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCaseCharge" ADD CONSTRAINT "ServiceCaseCharge_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceCaseBillingLink" (
  "id"                SERIAL NOT NULL,
  "businessId"        INTEGER NOT NULL,
  "caseId"            INTEGER NOT NULL,
  "billingDocumentId" INTEGER NOT NULL,
  "role"              "ServiceBillingLinkRole" NOT NULL,
  "linkedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkedByUserId"    INTEGER,
  "unlinkedAt"        TIMESTAMP(3),
  "unlinkedByUserId"  INTEGER,
  "unlinkReason"      TEXT,
  "erasedAt"          TIMESTAMP(3),
  CONSTRAINT "ServiceCaseBillingLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseBillingLink_unlink" CHECK (
    ("unlinkedAt" IS NULL AND "unlinkedByUserId" IS NULL AND "unlinkReason" IS NULL)
    OR ("unlinkedAt" IS NOT NULL AND "unlinkedAt" >= "linkedAt"
        AND (("unlinkReason" IS NOT NULL AND char_length(btrim("unlinkReason")) BETWEEN 1 AND 1000) OR "erasedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "ServiceCaseBillingLink_businessId_id_key" ON "ServiceCaseBillingLink"("businessId", "id");
-- a billing document belongs to at most one case at a time (no double count across cases)
CREATE UNIQUE INDEX "ServiceCaseBillingLink_one_active_per_document" ON "ServiceCaseBillingLink"("businessId", "billingDocumentId")
  WHERE "unlinkedAt" IS NULL;
CREATE INDEX "ServiceCaseBillingLink_businessId_caseId_idx" ON "ServiceCaseBillingLink"("businessId", "caseId");
ALTER TABLE "ServiceCaseBillingLink" ADD CONSTRAINT "ServiceCaseBillingLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseBillingLink" ADD CONSTRAINT "ServiceCaseBillingLink_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCaseBillingLink" ADD CONSTRAINT "ServiceCaseBillingLink_linkedBy_fkey"
  FOREIGN KEY ("linkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseBillingLink" ADD CONSTRAINT "ServiceCaseBillingLink_unlinkedBy_fkey"
  FOREIGN KEY ("unlinkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "ServiceCaseCharge_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceCaseCharge"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');
CREATE TRIGGER "ServiceCaseBillingLink_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "linkedByUserId", "unlinkedByUserId" ON "ServiceCaseBillingLink"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('linkedByUserId', 'unlinkedByUserId');

-- ── 3. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- The erasure scrub runs only inside service_case_charge_erase_business() (marker + table owner).
CREATE OR REPLACE FUNCTION public.service_charge_in_erasure(p_relid oid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('dubiz.service_charge_erasure', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_relid)
$fn$;
REVOKE ALL ON FUNCTION public.service_charge_in_erasure(oid) FROM PUBLIC;

-- 3.1 Charge history: append-only, gap-free seq per case (serialised on the case row), a quote approval carries the
-- approved amount of that very version.
CREATE OR REPLACE FUNCTION public.service_case_charge_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_last integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_APPEND_ONLY: a charge record is never changed or deleted; a change is a new record';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_charge_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['reason', 'actorUserId', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['reason', 'actorUserId', 'erasedAt'])
       AND NEW."reason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    -- the foreign key's ON DELETE SET NULL of a deleted user
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_APPEND_ONLY: a charge record is never changed or deleted; a change is a new record';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_ERASED_ON_INSERT: a new charge record is never born erased';
  END IF;
  PERFORM 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_CASE: no such case in this business';
  END IF;
  SELECT max(h."seq") INTO v_last FROM public."ServiceCaseCharge" h WHERE h."businessId" = NEW."businessId" AND h."caseId" = NEW."caseId";
  IF NEW."seq" <> COALESCE(v_last, 0) + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_SEQ: a charge record follows the last one of its case (seq gap-free)';
  END IF;
  IF NEW."source" = 'APPROVED_QUOTE' AND NOT EXISTS (SELECT 1 FROM public."ServiceQuote" q
       WHERE q."businessId" = NEW."businessId" AND q."caseId" = NEW."caseId" AND q."version" = NEW."quoteVersion"
         AND q."state" = 'APPROVED' AND q."approvedTotalAgorot" = NEW."amountAgorot" AND q."currency" = 'ILS') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_CHARGE_QUOTE: a charge from a quote is that approved version, at its approved ILS amount';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_charge_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseCharge_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseCharge"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_charge_guard();
CREATE TRIGGER "ServiceCaseCharge_no_truncate" BEFORE TRUNCATE ON "ServiceCaseCharge"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.2 Billing links: the document exists in THIS business (read as the caller, under RLS) and its type fits the
-- role; a link is unlinked once, with who and why; nothing else ever changes.
CREATE OR REPLACE FUNCTION public.service_case_billing_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_type text;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_KEPT: a link is never deleted; it is unlinked, with a reason';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_charge_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['linkedByUserId', 'unlinkedByUserId', 'unlinkReason', 'erasedAt'])
         = (to_jsonb(OLD) - ARRAY['linkedByUserId', 'unlinkedByUserId', 'unlinkReason', 'erasedAt'])
       AND NEW."linkedByUserId" IS NULL AND NEW."unlinkedByUserId" IS NULL AND NEW."unlinkReason" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - ARRAY['linkedByUserId', 'unlinkedByUserId']) = (to_jsonb(OLD) - ARRAY['linkedByUserId', 'unlinkedByUserId'])
       AND (NEW."linkedByUserId" IS NULL OR NEW."linkedByUserId" = OLD."linkedByUserId")
       AND (NEW."unlinkedByUserId" IS NULL OR NEW."unlinkedByUserId" IS NOT DISTINCT FROM OLD."unlinkedByUserId") THEN
      RETURN NEW;
    END IF;
    IF OLD."unlinkedAt" IS NULL AND OLD."erasedAt" IS NULL AND NEW."unlinkedAt" IS NOT NULL
       AND NEW."unlinkedByUserId" IS NOT NULL AND NEW."unlinkReason" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['unlinkedAt', 'unlinkedByUserId', 'unlinkReason'])
         = (to_jsonb(OLD) - ARRAY['unlinkedAt', 'unlinkedByUserId', 'unlinkReason']) THEN
      IF NOT public.service_ui_business_writable(NEW."businessId") THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_KEPT: a link only gets unlinked once (time, who, reason); nothing else changes';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF NEW."linkedByUserId" IS NULL OR NEW."unlinkedAt" IS NOT NULL OR NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_NEW: a new link is active and records who linked it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_CASE: no such case in this business';
  END IF;
  -- the only read of a billing table: one row by primary key, no lock clause (ACCESS SHARE only), under the caller's RLS
  SELECT d."documentType"::text, d."status"::text INTO v_type, v_status FROM public."BillingDocument" d
   WHERE d."id" = NEW."billingDocumentId" AND d."businessId" = NEW."businessId";
  IF v_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_DOCUMENT: no such billing document in this business';
  END IF;
  IF NOT ((NEW."role" = 'CHARGE' AND v_type IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT'))
       OR (NEW."role" = 'STANDALONE_PAYMENT' AND v_type = 'RECEIPT')
       OR (NEW."role" = 'AFTER_SALE_CREDIT' AND v_type = 'CREDIT_NOTE')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_ROLE: CHARGE links a tax invoice (or tax invoice / receipt); STANDALONE_PAYMENT a receipt; AFTER_SALE_CREDIT a credit note';
  END IF;
  -- a payment is credited only from an issued receipt (an invoice may be linked as a draft: the reader answers UNKNOWN)
  IF NEW."role" = 'STANDALONE_PAYMENT' AND v_status IS DISTINCT FROM 'ISSUED' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED: only an issued receipt is linked as a payment';
  END IF;
  IF NEW."role" = 'AFTER_SALE_CREDIT' AND v_status IS DISTINCT FROM 'ISSUED' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU13', MESSAGE = 'SERVICE_BILLING_LINK_CREDIT_NOT_ISSUED: only an issued credit note is the record of an after-sale credit';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_billing_link_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseBillingLink_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseBillingLink"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_billing_link_guard();
CREATE TRIGGER "ServiceCaseBillingLink_no_truncate" BEFORE TRUNCATE ON "ServiceCaseBillingLink"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- ── 4. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- Called inside the purge transaction, after service_desk_ui_erase_business(): blanks who acted and the free-text
-- reasons IN PLACE. Amounts, modes, sources, document ids, roles and times stay as the business's (anonymised)
-- financial record. Re-run safe.
CREATE OR REPLACE FUNCTION public.service_case_charge_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_CHARGE_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_CHARGE_ERASURE_NOT_DELETING: only a business being deleted is erased; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_charge_erasure', 'on', true);
  UPDATE public."ServiceCaseCharge" SET "reason" = NULL, "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseBillingLink" SET "linkedByUserId" = NULL, "unlinkedByUserId" = NULL, "unlinkReason" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  PERFORM set_config('dubiz.service_charge_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_charge_erase_business() FROM PUBLIC;

-- ── 5. Row-level security ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ServiceCaseCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseCharge" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_charge_tenant_select ON "ServiceCaseCharge" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_charge_tenant_insert ON "ServiceCaseCharge" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseBillingLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseBillingLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_billing_link_tenant_select ON "ServiceCaseBillingLink" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_billing_link_tenant_insert ON "ServiceCaseBillingLink" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_billing_link_tenant_update ON "ServiceCaseBillingLink" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 6. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceCaseCharge", "ServiceCaseBillingLink" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceCaseCharge_id_seq", "ServiceCaseBillingLink_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceCaseCharge', 'ServiceCaseBillingLink', 'ServiceCaseCharge_id_seq', 'ServiceCaseBillingLink_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', r.rel, r.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
    END IF;
  END LOOP;
END
$do$;
GRANT SELECT, INSERT ON "ServiceCaseCharge" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ServiceCaseBillingLink" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCaseCharge_id_seq", "ServiceCaseBillingLink_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_case_charge_erase_business() TO app_runtime;
-- invoker helper the guards call
GRANT EXECUTE ON FUNCTION public.service_charge_in_erasure(oid) TO app_runtime;
