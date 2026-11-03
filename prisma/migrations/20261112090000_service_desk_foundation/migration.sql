-- ============================================================================================================
-- 20261112090000_service_desk_foundation — Service Desk (שירות, תיקונים ואחריות), data foundation 1.2a.
--
-- PR-1 of the migration-first rule: this migration and its PG17 lab only. No schema.prisma, no runtime code, no
-- feature flag row: nothing reads these tables until the application PR (task 1.3). Expand-only: seven NEW tables,
-- eleven NEW enum types and their own functions; no existing table, column, policy, grant or row is changed.
--
-- The tables mirror the pure core merged in #934 / #941 (lib/services/service-desk):
--   "ServiceCaseNumberSequence"  one gap-free counter per business (row-locked increment in the creating tx)
--   "ServiceDevice"              a customer's device, owned by (businessId, customerId)
--   "ServiceCase"                status / holdReason / outcome / cancellationRequested / version — the core's fields
--   "ServiceCaseIntake"          1:1 check-in record; frozen once signed (only the slip PDF key may still be set)
--   "ServiceQuote"               one row per quote version; content immutable, decision written once
--   "ServiceCaseEvent"           append-only journal; seq = the case's version after the transition
--   "ServiceHandover"            1:1 handover; immutable; an open balance needs the owner's reason
--
-- Owner decisions applied: ט-1 A (free-text reasons in business columns, never in the journal payload), ט-2 A (a
-- quote links to a BillingDocument by a plain FK + a trigger: same business, documentType QUOTE; Billing is not
-- changed), ז-1 A (REVISE_QUOTE: SUPERSEDED), ז-2 A (the sent PDF copy's key + sha256 are NOT NULL on every version).
-- SECURITY DEFINER: one function, search_path = pg_catalog, public, pg_temp (pg_temp LAST — the #905 finding).
-- Privileges: explicit; the migration FAILS if app_runtime is missing (no silent skip). No DELETE for the runtime.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_DESK_FOUNDATION: role app_runtime is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key') THEN
    RAISE EXCEPTION 'SERVICE_DESK_FOUNDATION: "Customer" ("businessId", "id") key is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'SERVICE_DESK_FOUNDATION: extension btree_gist is missing; nothing was changed';
  END IF;
END
$do$;
-- New tables only, but each FK briefly locks the table it references ("Business", "Customer", "StaffMember",
-- "User", "BillingDocument"): wait at most 5 s for a lock instead of queueing behind a long transaction.
SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceCaseKind" AS ENUM ('IN_SHOP', 'FIELD', 'MAINTENANCE');
CREATE TYPE "ServiceCaseStatus" AS ENUM (
  'OPEN', 'SCHEDULED', 'CHECKED_IN', 'DIAGNOSING', 'QUOTE_PENDING', 'IN_REPAIR', 'EXTERNAL', 'QA', 'READY',
  'DELIVERED', 'CLOSED', 'CANCELLED', 'ABANDONED');
CREATE TYPE "ServiceHoldReason" AS ENUM ('PARTS', 'CUSTOMER');
CREATE TYPE "ServiceOutcome" AS ENUM ('REPAIRED', 'NOT_REPAIRED', 'REPLACED', 'QUOTE_REJECTED', 'CANCELLED');
CREATE TYPE "ServiceCoverageSource" AS ENUM ('MANUFACTURER', 'STORE', 'REPAIR', 'CONTRACT');
CREATE TYPE "ServiceCoverageDecision" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
CREATE TYPE "ServiceQuoteState" AS ENUM ('SENT', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED');
CREATE TYPE "ServiceQuoteApprovalMethod" AS ENUM ('LINK', 'PHONE', 'IN_PERSON');
CREATE TYPE "ServiceActor" AS ENUM ('OWNER_USER', 'CUSTOMER_LINK', 'SYSTEM');
CREATE TYPE "ServiceCaseAction" AS ENUM (
  'SCHEDULE', 'CHECK_IN', 'START_DIAGNOSIS', 'SEND_QUOTE', 'REVISE_QUOTE', 'APPROVE_QUOTE', 'REJECT_QUOTE',
  'START_REPAIR', 'SET_HOLD', 'CLEAR_HOLD', 'SEND_TO_EXTERNAL', 'RETURN_FROM_EXTERNAL', 'FINISH_REPAIR', 'PASS_QA',
  'FAIL_QA', 'MARK_NOT_REPAIRABLE', 'DELIVER', 'CLOSE', 'CANCEL', 'ABANDON');
CREATE TYPE "ServiceEventType" AS ENUM (
  'case.scheduled', 'case.checked_in', 'case.diagnosis_started', 'quote.sent', 'quote.approved', 'quote.rejected',
  'quote.revised', 'repair.started', 'hold.set', 'hold.cleared', 'external.sent', 'external.returned',
  'repair.finished', 'qa.passed', 'qa.failed', 'case.not_repairable', 'case.delivered', 'case.closed',
  'case.cancelled', 'case.cancellation_requested', 'case.abandoned');

-- ── 2. ServiceCaseNumberSequence ────────────────────────────────────────────────────────────────────────────
-- Gap-free per business: the creating transaction takes the row lock (INSERT … ON CONFLICT DO UPDATE … RETURNING),
-- so a rolled-back creation returns its number and two concurrent creations of one business serialise.
CREATE TABLE "ServiceCaseNumberSequence" (
  "businessId" INTEGER NOT NULL,
  "nextValue"  INTEGER NOT NULL DEFAULT 1,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceCaseNumberSequence_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "ServiceCaseNumberSequence_next_positive" CHECK ("nextValue" >= 1)
);
ALTER TABLE "ServiceCaseNumberSequence" ADD CONSTRAINT "ServiceCaseNumberSequence_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. ServiceDevice ────────────────────────────────────────────────────────────────────────────────────────
-- No unique serial number: devices change hands and makers' numbers collide. No PIN / password column (ע-4).
CREATE TABLE "ServiceDevice" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "customerId"       INTEGER NOT NULL,
  "category"         TEXT,
  "brand"            TEXT,
  "model"            TEXT,
  "serialNumber"     TEXT,
  "serialNormalized" TEXT,
  "description"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"         TIMESTAMP(3),
  CONSTRAINT "ServiceDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceDevice_short_texts" CHECK (
        ("category" IS NULL OR char_length("category") <= 120)
    AND ("brand" IS NULL OR char_length("brand") <= 120)
    AND ("model" IS NULL OR char_length("model") <= 120)
    AND ("serialNumber" IS NULL OR char_length("serialNumber") <= 120)
    AND ("serialNormalized" IS NULL OR char_length("serialNormalized") <= 120)
    AND ("description" IS NULL OR char_length("description") <= 2000)),
  CONSTRAINT "ServiceDevice_serial_pair" CHECK (("serialNumber" IS NULL) = ("serialNormalized" IS NULL))
);
CREATE UNIQUE INDEX "ServiceDevice_businessId_id_key" ON "ServiceDevice"("businessId", "id");
-- The target of the case → device FK: a case may only name a device of ITS customer in ITS business.
CREATE UNIQUE INDEX "ServiceDevice_businessId_customerId_id_key" ON "ServiceDevice"("businessId", "customerId", "id");
CREATE INDEX "ServiceDevice_businessId_customerId_idx" ON "ServiceDevice"("businessId", "customerId");
CREATE INDEX "ServiceDevice_businessId_serialNormalized_idx" ON "ServiceDevice"("businessId", "serialNormalized");
ALTER TABLE "ServiceDevice" ADD CONSTRAINT "ServiceDevice_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceDevice" ADD CONSTRAINT "ServiceDevice_customer_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 4. ServiceCase ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceCase" (
  "id"                    SERIAL NOT NULL,
  "businessId"            INTEGER NOT NULL,
  "caseNumber"            INTEGER NOT NULL,
  "kind"                  "ServiceCaseKind" NOT NULL,
  "status"                "ServiceCaseStatus" NOT NULL DEFAULT 'OPEN',
  "holdReason"            "ServiceHoldReason",
  "outcome"               "ServiceOutcome",
  "cancellationRequested" BOOLEAN NOT NULL DEFAULT false,
  "version"               INTEGER NOT NULL DEFAULT 1,
  "customerId"            INTEGER NOT NULL,
  "deviceId"              INTEGER,
  "staffMemberId"         INTEGER,
  "parentCaseId"          INTEGER,
  "problemDescription"    TEXT,
  "diagnosisNote"         TEXT,
  "coverageSource"        "ServiceCoverageSource",
  "coverageDecision"      "ServiceCoverageDecision",
  "qaChecklist"           JSONB,
  "qaCompletedAt"         TIMESTAMP(3),
  "pickupRemindersSent"   INTEGER NOT NULL DEFAULT 0,
  "lastPickupReminderAt"  TIMESTAMP(3),
  "cancelReason"          TEXT,
  "cancelledAt"           TIMESTAMP(3),
  "abandonReason"         TEXT,
  "abandonedAt"           TIMESTAMP(3),
  "openedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedInAt"           TIMESTAMP(3),
  "readyAt"               TIMESTAMP(3),
  "deliveredAt"           TIMESTAMP(3),
  "closedAt"              TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"              TIMESTAMP(3),
  CONSTRAINT "ServiceCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCase_numbers" CHECK ("caseNumber" >= 1 AND "version" >= 1 AND "pickupRemindersSent" >= 0),
  CONSTRAINT "ServiceCase_not_own_parent" CHECK ("parentCaseId" IS NULL OR "parentCaseId" <> "id"),
  -- The core's three separate fields (1.1): a hold only while IN_REPAIR; an outcome exactly in the outcome statuses;
  -- CANCELLED is always outcome CANCELLED; a pending cancel request only while a supplier has the item.
  CONSTRAINT "ServiceCase_hold_only_in_repair" CHECK ("holdReason" IS NULL OR "status" = 'IN_REPAIR'),
  CONSTRAINT "ServiceCase_outcome_by_status" CHECK (
    ("outcome" IS NOT NULL) = ("status" IN ('READY', 'DELIVERED', 'CLOSED', 'ABANDONED', 'CANCELLED'))),
  CONSTRAINT "ServiceCase_cancelled_outcome" CHECK ("status" <> 'CANCELLED' OR "outcome" = 'CANCELLED'),
  CONSTRAINT "ServiceCase_cancel_request_only_external" CHECK (NOT "cancellationRequested" OR "status" = 'EXTERNAL'),
  CONSTRAINT "ServiceCase_coverage_pair" CHECK (("coverageSource" IS NULL) = ("coverageDecision" IS NULL)),
  -- Reasons (ט-1 A, 1.1b): trimmed, non-blank, at most 1000 code points — the core's SERVICE_REASON_MAX_LENGTH.
  CONSTRAINT "ServiceCase_reason_texts" CHECK (
        ("cancelReason" IS NULL OR (char_length("cancelReason") <= 1000 AND btrim("cancelReason") <> '' AND "cancelReason" = btrim("cancelReason")))
    AND ("abandonReason" IS NULL OR (char_length("abandonReason") <= 1000 AND btrim("abandonReason") <> '' AND "abandonReason" = btrim("abandonReason")))),
  CONSTRAINT "ServiceCase_other_texts" CHECK (
        ("problemDescription" IS NULL OR char_length("problemDescription") <= 4000)
    AND ("diagnosisNote" IS NULL OR char_length("diagnosisNote") <= 4000)
    AND ("qaChecklist" IS NULL OR (jsonb_typeof("qaChecklist") = 'object' AND octet_length("qaChecklist"::text) <= 8192))),
  CONSTRAINT "ServiceCase_problem_described" CHECK ("problemDescription" IS NOT NULL OR "erasedAt" IS NOT NULL),
  -- A held / at-supplier cancel carries its reason (the core refuses it otherwise); a direct CANCELLED may not.
  CONSTRAINT "ServiceCase_cancel_reason_kept" CHECK (
        ("outcome" IS DISTINCT FROM 'CANCELLED' OR "status" = 'CANCELLED' OR "cancelReason" IS NOT NULL OR "erasedAt" IS NOT NULL)
    AND (NOT "cancellationRequested" OR "cancelReason" IS NOT NULL OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "ServiceCase_cancel_stamp" CHECK (
    ("outcome" IS DISTINCT FROM 'CANCELLED' AND NOT "cancellationRequested") OR "cancelledAt" IS NOT NULL),
  CONSTRAINT "ServiceCase_abandon_stamp" CHECK (
        ("status" <> 'ABANDONED' OR "abandonedAt" IS NOT NULL)
    AND ("abandonedAt" IS NULL OR "abandonReason" IS NOT NULL OR "erasedAt" IS NOT NULL)
    AND ("abandonReason" IS NULL OR "abandonedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ServiceCase_businessId_id_key" ON "ServiceCase"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCase_businessId_caseNumber_key" ON "ServiceCase"("businessId", "caseNumber");
CREATE INDEX "ServiceCase_businessId_status_idx" ON "ServiceCase"("businessId", "status");
CREATE INDEX "ServiceCase_businessId_customerId_idx" ON "ServiceCase"("businessId", "customerId");
CREATE INDEX "ServiceCase_businessId_deviceId_idx" ON "ServiceCase"("businessId", "deviceId");
CREATE INDEX "ServiceCase_businessId_staffMemberId_idx" ON "ServiceCase"("businessId", "staffMemberId");
CREATE INDEX "ServiceCase_businessId_parentCaseId_idx" ON "ServiceCase"("businessId", "parentCaseId");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_customer_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- (businessId, customerId, deviceId): the device must be THIS customer's, in THIS business.
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_device_same_customer_fkey"
  FOREIGN KEY ("businessId", "customerId", "deviceId") REFERENCES "ServiceDevice"("businessId", "customerId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_staff_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_parent_tenant_fkey"
  FOREIGN KEY ("businessId", "parentCaseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 5. ServiceCaseIntake ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceCaseIntake" (
  "id"                  SERIAL NOT NULL,
  "businessId"          INTEGER NOT NULL,
  "caseId"              INTEGER NOT NULL,
  "deviceSnapshot"      JSONB NOT NULL DEFAULT '{}',
  "conditionNote"       TEXT,
  "accessoriesNote"     TEXT,
  "conditionRecorded"   BOOLEAN NOT NULL DEFAULT false,
  "accessoriesRecorded" BOOLEAN NOT NULL DEFAULT false,
  "customerSigned"      BOOLEAN NOT NULL DEFAULT false,
  "signatureKey"        TEXT,
  "slipPdfKey"          TEXT,
  "termsVersion"        TEXT,
  "signedAt"            TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"            TIMESTAMP(3),
  CONSTRAINT "ServiceCaseIntake_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseIntake_signed_pair" CHECK ("customerSigned" = ("signedAt" IS NOT NULL)),
  CONSTRAINT "ServiceCaseIntake_texts" CHECK (
        jsonb_typeof("deviceSnapshot") = 'object' AND octet_length("deviceSnapshot"::text) <= 4096
    AND ("conditionNote" IS NULL OR char_length("conditionNote") <= 4000)
    AND ("accessoriesNote" IS NULL OR char_length("accessoriesNote") <= 2000)
    AND ("termsVersion" IS NULL OR char_length("termsVersion") <= 64)),
  -- Object keys are this business's private service objects (the future storage domain "service").
  CONSTRAINT "ServiceCaseIntake_object_keys" CHECK (
        ("signatureKey" IS NULL OR "signatureKey" LIKE ('biz/' || "businessId" || '/service/%'))
    AND ("slipPdfKey"   IS NULL OR "slipPdfKey"   LIKE ('biz/' || "businessId" || '/service/%')))
);
CREATE UNIQUE INDEX "ServiceCaseIntake_businessId_id_key" ON "ServiceCaseIntake"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCaseIntake_businessId_caseId_key" ON "ServiceCaseIntake"("businessId", "caseId");
ALTER TABLE "ServiceCaseIntake" ADD CONSTRAINT "ServiceCaseIntake_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseIntake" ADD CONSTRAINT "ServiceCaseIntake_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 6. ServiceQuote ─────────────────────────────────────────────────────────────────────────────────────────
-- One row per version. What was offered never changes; the decision on it is written once, leaving SENT.
-- docHash = the service's hash of the quote CONTENT (not BillingDocument.pdfHash — see the 1.2 consistency check);
-- sentPdfKey / sentPdfSha256 = the private copy of the PDF the customer received (ז-2 A), prepared before the row.
CREATE TABLE "ServiceQuote" (
  "id"                  SERIAL NOT NULL,
  "businessId"          INTEGER NOT NULL,
  "caseId"              INTEGER NOT NULL,
  "version"             INTEGER NOT NULL,
  "billingDocumentId"   INTEGER NOT NULL,
  "totalAgorot"         INTEGER NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'ILS',
  "docHash"             TEXT NOT NULL,
  "sentPdfKey"          TEXT NOT NULL,
  "sentPdfSha256"       TEXT NOT NULL,
  "sentAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentByUserId"        INTEGER,
  "state"               "ServiceQuoteState" NOT NULL DEFAULT 'SENT',
  "decidedAt"           TIMESTAMP(3),
  "decidedByActor"      "ServiceActor",
  "decidedByUserId"     INTEGER,
  "approvalMethod"      "ServiceQuoteApprovalMethod",
  "approvedVersion"     INTEGER,
  "approvedTotalAgorot" INTEGER,
  "approvedDocHash"     TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQuote_content" CHECK (
        "version" >= 1 AND "totalAgorot" >= 0 AND "currency" = 'ILS'
    AND "docHash" ~ '^[0-9a-f]{64}$' AND "sentPdfSha256" ~ '^[0-9a-f]{64}$'
    AND "sentPdfKey" LIKE ('biz/' || "businessId" || '/service/%') AND char_length("sentPdfKey") <= 512),
  CONSTRAINT "ServiceQuote_decided" CHECK (
        ("state" = 'SENT') = ("decidedAt" IS NULL)
    AND ("state" = 'SENT') = ("decidedByActor" IS NULL)
    AND ("decidedByUserId" IS NULL OR "decidedByActor" = 'OWNER_USER')),
  -- An approval names exactly this row's version, total and content hash — and exists only when APPROVED.
  CONSTRAINT "ServiceQuote_approval_is_this_row" CHECK (
    CASE WHEN "state" = 'APPROVED' THEN
           "approvalMethod" IS NOT NULL
       AND "approvedVersion" = "version" AND "approvedTotalAgorot" = "totalAgorot" AND "approvedDocHash" = "docHash"
       AND ("approvalMethod" = 'LINK') = ("decidedByActor" = 'CUSTOMER_LINK')
    ELSE "approvalMethod" IS NULL AND "approvedVersion" IS NULL AND "approvedTotalAgorot" IS NULL AND "approvedDocHash" IS NULL
    END)
);
CREATE UNIQUE INDEX "ServiceQuote_businessId_id_key" ON "ServiceQuote"("businessId", "id");
CREATE UNIQUE INDEX "ServiceQuote_businessId_caseId_version_key" ON "ServiceQuote"("businessId", "caseId", "version");
-- At most one open (SENT) version per case.
CREATE UNIQUE INDEX "ServiceQuote_one_sent_per_case" ON "ServiceQuote"("businessId", "caseId") WHERE "state" = 'SENT';
CREATE INDEX "ServiceQuote_businessId_billingDocumentId_idx" ON "ServiceQuote"("businessId", "billingDocumentId");
-- One BillingDocument belongs to one case: versions of the same case may share it, two cases never (race-safe).
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_billing_document_one_case"
  EXCLUDE USING gist ("billingDocumentId" WITH =, "caseId" WITH <>);
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- ט-2 A: a plain FK (BillingDocument has no (businessId, id) key and is not changed); the business and the type are
-- checked by "ServiceQuote_billing_document_guard". A linked quote document cannot be deleted.
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_billingDocumentId_fkey"
  FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_sentByUserId_fkey"
  FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 7. ServiceCaseEvent — the append-only journal ───────────────────────────────────────────────────────────
CREATE TABLE "ServiceCaseEvent" (
  "id"                          SERIAL NOT NULL,
  "businessId"                  INTEGER NOT NULL,
  "caseId"                      INTEGER NOT NULL,
  "seq"                         INTEGER NOT NULL,
  "eventType"                   "ServiceEventType" NOT NULL,
  "action"                      "ServiceCaseAction" NOT NULL,
  "fromStatus"                  "ServiceCaseStatus" NOT NULL,
  "toStatus"                    "ServiceCaseStatus" NOT NULL,
  "holdReasonBefore"            "ServiceHoldReason",
  "holdReasonAfter"             "ServiceHoldReason",
  "cancellationRequestedBefore" BOOLEAN NOT NULL,
  "cancellationRequestedAfter"  BOOLEAN NOT NULL,
  "outcome"                     "ServiceOutcome",
  "actor"                       "ServiceActor" NOT NULL,
  "actorUserId"                 INTEGER,
  "occurredAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload"                     JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey"              TEXT NOT NULL,
  "requestDigest"               TEXT,
  "digestKeyId"                 TEXT,
  CONSTRAINT "ServiceCaseEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseEvent_seq_positive" CHECK ("seq" >= 1),
  CONSTRAINT "ServiceCaseEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "ServiceCaseEvent_fields" CHECK (
        ("holdReasonAfter" IS NULL OR "toStatus" = 'IN_REPAIR')
    AND (NOT "cancellationRequestedAfter" OR "toStatus" = 'EXTERNAL')),
  CONSTRAINT "ServiceCaseEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))),
  -- A closed payload (ט-1 A): an object of numbers, booleans, nulls and SHORT TOKENS — never free text, never PII.
  CONSTRAINT "ServiceCaseEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))'))
);
CREATE UNIQUE INDEX "ServiceCaseEvent_businessId_idempotencyKey_key" ON "ServiceCaseEvent"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "ServiceCaseEvent_businessId_caseId_seq_key" ON "ServiceCaseEvent"("businessId", "caseId", "seq");
CREATE INDEX "ServiceCaseEvent_businessId_occurredAt_idx" ON "ServiceCaseEvent"("businessId", "occurredAt");
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 8. ServiceHandover ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceHandover" (
  "id"                   SERIAL NOT NULL,
  "businessId"           INTEGER NOT NULL,
  "caseId"               INTEGER NOT NULL,
  "receivedByName"       TEXT,
  "signatureCaptured"    BOOLEAN NOT NULL,
  "signatureKey"         TEXT,
  "openBalanceAgorot"    INTEGER NOT NULL,
  "debtOverrideReason"   TEXT,
  "loanerOverrideReason" TEXT,
  "deliveredAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorUserId"          INTEGER,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"             TIMESTAMP(3),
  CONSTRAINT "ServiceHandover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceHandover_signed" CHECK ("signatureCaptured"),
  CONSTRAINT "ServiceHandover_receiver" CHECK (
    ("receivedByName" IS NOT NULL AND btrim("receivedByName") <> '' AND char_length("receivedByName") <= 200)
    OR ("receivedByName" IS NULL AND "erasedAt" IS NOT NULL)),
  -- Owner decision ש4: an open balance is handed over only with the owner's reason; the debt itself stays in Billing.
  CONSTRAINT "ServiceHandover_debt_needs_reason" CHECK (
    "openBalanceAgorot" <= 0 OR "debtOverrideReason" IS NOT NULL OR "erasedAt" IS NOT NULL),
  CONSTRAINT "ServiceHandover_reason_texts" CHECK (
        ("debtOverrideReason" IS NULL OR (char_length("debtOverrideReason") <= 1000 AND btrim("debtOverrideReason") <> '' AND "debtOverrideReason" = btrim("debtOverrideReason")))
    AND ("loanerOverrideReason" IS NULL OR (char_length("loanerOverrideReason") <= 1000 AND btrim("loanerOverrideReason") <> '' AND "loanerOverrideReason" = btrim("loanerOverrideReason")))),
  CONSTRAINT "ServiceHandover_object_key" CHECK (
    "signatureKey" IS NULL OR "signatureKey" LIKE ('biz/' || "businessId" || '/service/%'))
);
CREATE UNIQUE INDEX "ServiceHandover_businessId_id_key" ON "ServiceHandover"("businessId", "id");
-- One handover per case: a second delivery is refused here, whatever the caller does.
CREATE UNIQUE INDEX "ServiceHandover_businessId_caseId_key" ON "ServiceHandover"("businessId", "caseId");
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 9. Guards (triggers) ────────────────────────────────────────────────────────────────────────────────────
-- Every guard runs as the invoker. "In erasure" = the transaction-local marker set by service_erase_business() AND
-- running as the table owner (inside that SECURITY DEFINER function): app_runtime can set the marker, never the owner.

-- 9.1 A "User" reference must name a user of the row's business ("User" has no tenant key to build an FK on).
CREATE OR REPLACE FUNCTION public.service_user_same_business()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  col text;
  uid integer;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    uid := (to_jsonb(NEW) ->> col)::integer;
    IF uid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZS03',
        MESSAGE = format('SERVICE_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_user_same_business() FROM PUBLIC;
CREATE TRIGGER "ServiceQuote_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "sentByUserId", "decidedByUserId" ON "ServiceQuote"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('sentByUserId', 'decidedByUserId');
CREATE TRIGGER "ServiceCaseEvent_user_same_business"
  BEFORE INSERT ON "ServiceCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');
CREATE TRIGGER "ServiceHandover_user_same_business"
  BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- 9.2 ServiceCase: identity fixed, version never decreases, reasons and their stamps written once.
CREATE OR REPLACE FUNCTION public.service_case_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."caseNumber" <> OLD."caseNumber"
     OR NEW."kind" <> OLD."kind" OR NEW."customerId" <> OLD."customerId"
     OR NEW."parentCaseId" IS DISTINCT FROM OLD."parentCaseId"
     OR NEW."openedAt" <> OLD."openedAt" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_IDENTITY_FIXED: id, business, number, kind, customer, parent and opening time never change';
  END IF;
  IF OLD."deviceId" IS NOT NULL AND NEW."deviceId" IS DISTINCT FROM OLD."deviceId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_DEVICE_FIXED: a case''s device, once set, never changes';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_VERSION_BACKWARDS: the version never decreases';
  END IF;
  IF OLD."erasedAt" IS NOT NULL AND NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_ERASED_FIXED: the erasure stamp never changes';
  END IF;
  IF (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (OLD."abandonedAt" IS NOT NULL AND NEW."abandonedAt" IS DISTINCT FROM OLD."abandonedAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_STAMP_WRITE_ONCE: cancelledAt / abandonedAt are written once';
  END IF;
  -- Reasons: written once; only the erasure may blank them (to NULL, never to another text).
  IF (OLD."cancelReason" IS NOT NULL AND NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason"
        AND NOT (in_erasure AND NEW."cancelReason" IS NULL))
     OR (OLD."abandonReason" IS NOT NULL AND NEW."abandonReason" IS DISTINCT FROM OLD."abandonReason"
        AND NOT (in_erasure AND NEW."abandonReason" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_REASON_WRITE_ONCE: a reason, once recorded, never changes';
  END IF;
  IF NOT in_erasure AND (
       (OLD."problemDescription" IS NOT NULL AND NEW."problemDescription" IS NULL)
    OR (NEW."erasedAt" IS NOT NULL AND OLD."erasedAt" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_ERASURE_ONLY: only the account erasure blanks a case';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCase_guard" BEFORE UPDATE ON "ServiceCase"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_guard();

-- 9.3 ServiceDevice: business and customer fixed; erasure only by the erasure function.
CREATE OR REPLACE FUNCTION public.service_device_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."customerId" <> OLD."customerId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_DEVICE_OWNER_FIXED: a device''s business and customer never change';
  END IF;
  IF (OLD."erasedAt" IS NOT NULL AND NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt")
     OR (NOT in_erasure AND NEW."erasedAt" IS NOT NULL AND OLD."erasedAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_DEVICE_ERASURE_ONLY: only the account erasure erases a device';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_device_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceDevice_guard" BEFORE UPDATE ON "ServiceDevice"
  FOR EACH ROW EXECUTE FUNCTION public.service_device_guard();

-- 9.4 ServiceCaseIntake: once signed, only slipPdfKey may still be set (NULL → key); the erasure blanks the texts.
CREATE OR REPLACE FUNCTION public.service_intake_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['deviceSnapshot', 'conditionNote', 'accessoriesNote', 'signatureKey', 'erasedAt', 'updatedAt'];
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."caseId" <> OLD."caseId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_INTAKE_OWNER_FIXED: an intake''s business and case never change';
  END IF;
  IF in_erasure THEN
    IF (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."deviceSnapshot" = '{}'::jsonb AND NEW."conditionNote" IS NULL AND NEW."accessoriesNote" IS NULL
       AND NEW."signatureKey" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_INTAKE_ERASURE_SHAPE: the erasure only blanks the personal fields';
  END IF;
  IF NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_INTAKE_ERASURE_ONLY: only the account erasure erases an intake';
  END IF;
  IF OLD."signedAt" IS NOT NULL THEN
    IF (to_jsonb(NEW) - ARRAY['slipPdfKey', 'updatedAt']) <> (to_jsonb(OLD) - ARRAY['slipPdfKey', 'updatedAt'])
       OR (OLD."slipPdfKey" IS NOT NULL AND NEW."slipPdfKey" IS DISTINCT FROM OLD."slipPdfKey") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_INTAKE_SIGNED: a signed intake is frozen; only the slip PDF key may be added once';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_intake_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseIntake_guard" BEFORE UPDATE ON "ServiceCaseIntake"
  FOR EACH ROW EXECUTE FUNCTION public.service_intake_guard();

-- 9.5 ServiceQuote, INSERT (ט-2 A): the BillingDocument must be visible to this business and be a QUOTE. Runs as
-- the invoker: under Production's FORCE RLS on "BillingDocument" another business's document is simply not found.
-- One message for "absent", "another business" and "not a quote": nothing about a foreign document leaks.
CREATE OR REPLACE FUNCTION public.service_quote_billing_document_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BillingDocument" d
     WHERE d."id" = NEW."billingDocumentId" AND d."businessId" = NEW."businessId" AND d."documentType" = 'QUOTE'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZS04',
      MESSAGE = 'SERVICE_QUOTE_DOCUMENT_INVALID: billingDocumentId must name a QUOTE document of the same business';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_quote_billing_document_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQuote_billing_document_guard" BEFORE INSERT ON "ServiceQuote"
  FOR EACH ROW EXECUTE FUNCTION public.service_quote_billing_document_guard();

-- 9.6 ServiceQuote, UPDATE: content immutable; the decision leaves SENT exactly once; final states never change.
-- Allowed besides: the FK action nulling a deleted user (cascade depth > 1), and the erasure nulling user ids.
CREATE OR REPLACE FUNCTION public.service_quote_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  users constant text[] := ARRAY['sentByUserId', 'decidedByUserId'];
  decision constant text[] := ARRAY['state', 'decidedAt', 'decidedByActor', 'decidedByUserId', 'approvalMethod',
                                    'approvedVersion', 'approvedTotalAgorot', 'approvedDocHash'];
BEGIN
  -- Only user ids nulled (erasure, or the FK action of a deleted user): nothing else may move.
  IF (to_jsonb(NEW) - users) = (to_jsonb(OLD) - users)
     AND (NEW."sentByUserId" IS NULL OR NEW."sentByUserId" IS NOT DISTINCT FROM OLD."sentByUserId")
     AND (NEW."decidedByUserId" IS NULL OR NEW."decidedByUserId" IS NOT DISTINCT FROM OLD."decidedByUserId")
     AND (in_erasure OR pg_trigger_depth() > 1) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - decision) <> (to_jsonb(OLD) - decision) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = 'SERVICE_QUOTE_CONTENT_FIXED: a quote version''s content never changes';
  END IF;
  IF OLD."state" <> 'SENT' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = format('SERVICE_QUOTE_FINAL: version %s is %s; its decision never changes', OLD."version", OLD."state");
  END IF;
  IF NEW."state" = 'SENT' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = 'SERVICE_QUOTE_DECISION_REQUIRED: an update of a SENT version must decide it';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_quote_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQuote_guard" BEFORE UPDATE ON "ServiceQuote"
  FOR EACH ROW EXECUTE FUNCTION public.service_quote_guard();

-- 9.7 ServiceCaseEvent, INSERT: the event mirrors the case as the same transaction just left it — seq is the case's
-- (new) version, and toStatus / holdReasonAfter / cancellationRequestedAfter / outcome are the case's current values.
-- So a transition's case update and its event agree, and an event cannot be written for a state that was not.
CREATE OR REPLACE FUNCTION public.service_event_matches_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
BEGIN
  SELECT "version", "status", "holdReason", "cancellationRequested", "outcome" INTO c
    FROM "ServiceCase" WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS05', MESSAGE = 'SERVICE_EVENT_CASE_INVALID: the event must name a case of the same business';
  END IF;
  IF NEW."seq" <> c."version" OR NEW."toStatus" <> c."status"
     OR NEW."holdReasonAfter" IS DISTINCT FROM c."holdReason"
     OR NEW."cancellationRequestedAfter" <> c."cancellationRequested"
     OR NEW."outcome" IS DISTINCT FROM c."outcome" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZS05',
      MESSAGE = format('SERVICE_EVENT_CASE_MISMATCH: event seq %s must equal the case version %s, and its after-state the case''s', NEW."seq", c."version");
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_event_matches_case() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseEvent_matches_case" BEFORE INSERT ON "ServiceCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_event_matches_case();

-- 9.8 ServiceCaseEvent: append-only (as "AppointmentEvent"). DELETE only by the cascade of a deleted business; UPDATE
-- only by the erasure (user / digest columns to NULL) or the FK action of a deleted user ("actorUserId" to NULL).
CREATE OR REPLACE FUNCTION public.service_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZS06',
    MESSAGE = format('SERVICE_EVENT_APPEND_ONLY: %s on %I is refused; the service journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_event_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_journal_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DZS06', MESSAGE = format('SERVICE_JOURNAL_NO_TRUNCATE: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_journal_truncate_guard() FROM PUBLIC;

CREATE TRIGGER "ServiceCaseEvent_append_only" BEFORE UPDATE OR DELETE ON "ServiceCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_event_append_only_guard();
CREATE TRIGGER "ServiceCaseEvent_no_truncate" BEFORE TRUNCATE ON "ServiceCaseEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 9.9 ServiceHandover: immutable. UPDATE only by the erasure (personal fields to NULL, erasedAt set) or the FK action
-- of a deleted user; DELETE only by the cascade of a deleted business.
CREATE OR REPLACE FUNCTION public.service_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['receivedByName', 'signatureKey', 'debtOverrideReason', 'loanerOverrideReason', 'actorUserId', 'erasedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."receivedByName" IS NULL AND NEW."signatureKey" IS NULL AND NEW."debtOverrideReason" IS NULL
       AND NEW."loanerOverrideReason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_HANDOVER_FIXED: %s on %I is refused; a handover is a permanent record', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceHandover_guard" BEFORE UPDATE OR DELETE ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_handover_guard();
CREATE TRIGGER "ServiceHandover_no_truncate" BEFORE TRUNCATE ON "ServiceHandover"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- ── 10. Account erasure — the runtime's one path to blank personal data ────────────────────────────────────
-- CONTRACT (input → output): no arguments; the business is the tenant context. Refuses (DZS08, nothing changed)
-- without a context or when that business is not being deleted (deletionRequestedAt / deletedAt). Otherwise blanks,
-- for that business only: case free text, device serial / description, intake notes / snapshot / signature key,
-- handover receiver / signature key / reasons / actor, journal actor and request digests, quote user ids; stamps
-- erasedAt. Returns the number of rows touched. Business facts (statuses, amounts, versions, hashes) stay.
-- The account-deletion flow will call it in its tenant transaction (wired with the application, task 1.3).
CREATE OR REPLACE FUNCTION public.service_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_erasure', 'on', true);

  UPDATE public."ServiceCase" SET "problemDescription" = NULL, "diagnosisNote" = NULL, "cancelReason" = NULL,
         "abandonReason" = NULL, "erasedAt" = COALESCE("erasedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceDevice" SET "serialNumber" = NULL, "serialNormalized" = NULL, "description" = NULL,
         "erasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseIntake" SET "deviceSnapshot" = '{}', "conditionNote" = NULL, "accessoriesNote" = NULL,
         "signatureKey" = NULL, "erasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceHandover" SET "receivedByName" = NULL, "signatureKey" = NULL, "debtOverrideReason" = NULL,
         "loanerOverrideReason" = NULL, "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE "businessId" = v_business AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceQuote" SET "sentByUserId" = NULL, "decidedByUserId" = NULL
   WHERE "businessId" = v_business AND ("sentByUserId" IS NOT NULL OR "decidedByUserId" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_erase_business() FROM PUBLIC;

-- ── 11. Row-level security — per operation, no DELETE policy anywhere ──────────────────────────────────────
ALTER TABLE "ServiceCaseNumberSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseNumberSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_number_tenant_select ON "ServiceCaseNumberSequence" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_number_tenant_insert ON "ServiceCaseNumberSequence" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_number_tenant_update ON "ServiceCaseNumberSequence" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceDevice" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_device_tenant_select ON "ServiceDevice" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_device_tenant_insert ON "ServiceDevice" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_device_tenant_update ON "ServiceDevice" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_tenant_select ON "ServiceCase" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_tenant_insert ON "ServiceCase" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_tenant_update ON "ServiceCase" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseIntake" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseIntake" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_intake_tenant_select ON "ServiceCaseIntake" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_intake_tenant_insert ON "ServiceCaseIntake" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_intake_tenant_update ON "ServiceCaseIntake" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceQuote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_quote_tenant_select ON "ServiceQuote" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_quote_tenant_insert ON "ServiceQuote" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_quote_tenant_update ON "ServiceQuote" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_event_tenant_select ON "ServiceCaseEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_event_tenant_insert ON "ServiceCaseEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceHandover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceHandover" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_handover_tenant_select ON "ServiceHandover" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_handover_tenant_insert ON "ServiceHandover" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 12. Privileges — named explicitly ──────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceCaseNumberSequence", "ServiceDevice", "ServiceCase", "ServiceCaseIntake", "ServiceQuote",
              "ServiceCaseEvent", "ServiceHandover" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceDevice_id_seq", "ServiceCase_id_seq", "ServiceCaseIntake_id_seq", "ServiceQuote_id_seq",
              "ServiceCaseEvent_id_seq", "ServiceHandover_id_seq" FROM PUBLIC;
-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceCaseNumberSequence', 'ServiceDevice', 'ServiceCase', 'ServiceCaseIntake',
                         'ServiceQuote', 'ServiceCaseEvent', 'ServiceHandover',
                         'ServiceDevice_id_seq', 'ServiceCase_id_seq', 'ServiceCaseIntake_id_seq',
                         'ServiceQuote_id_seq', 'ServiceCaseEvent_id_seq', 'ServiceHandover_id_seq')
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
-- app_runtime exists (checked in section 0, so this never skips).
GRANT SELECT, INSERT, UPDATE ON "ServiceCaseNumberSequence" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ServiceDevice" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceDevice_id_seq" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ServiceCase" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCase_id_seq" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ServiceCaseIntake" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCaseIntake_id_seq" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "ServiceQuote" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceQuote_id_seq" TO app_runtime;
-- Append-only / permanent records: read and add, nothing else.
GRANT SELECT, INSERT ON "ServiceCaseEvent" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCaseEvent_id_seq" TO app_runtime;
GRANT SELECT, INSERT ON "ServiceHandover" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceHandover_id_seq" TO app_runtime;
-- Account erasure runs as the runtime inside the erased business's tenant transaction (the function checks both).
GRANT EXECUTE ON FUNCTION public.service_erase_business() TO app_runtime;
