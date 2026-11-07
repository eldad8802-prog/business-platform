-- Business documents — records for ר1 (quote share copies + manual events) and saved letters (migration only)
--
-- Owner approval 2026-11-06 ("חבילת מימוש… עד Draft PRs"). Expand-only: six NEW tenant tables, their enums, guard
-- functions, two erasure functions that NOTHING calls yet (connecting them to account deletion is not approved), one
-- letter purge function that nothing calls (retention is not approved), and the flag definition — OFF.
--
-- NOTHING EXISTING CHANGES. No existing table, column, constraint, policy, grant, function or row is altered. In
-- particular the billing mechanism is untouched: "BillingDocument" is only READ, by a SECURITY INVOKER trigger
-- under the caller's own RLS, to check that a quote link points at a QUOTE of the same business.
--
-- THE TABLES
--   "BusinessDocumentFile"     one stored PDF object in the private storage domain business-docs. State machine
--                              PENDING → COMMITTED | PENDING → DELETING | COMMITTED → DELETING (only while nothing
--                              references it) | DELETING → FENCED, enforced here. FENCED = the object was deleted and
--                              a data-free marker was created in its key with a create-once write, so a late upload
--                              (R2 may commit an abandoned PUT later) can never land. The row stays as the record of
--                              that key until the account is erased.
--   "BusinessDocumentRequest"  server-issued idempotency keys. A key is issued for one operation, used within 24 hours
--                              of issue, replays its first result, and refuses a different request body.
--   "QuoteShareCopy"           a NEW copy rendered from a quote and stored for sharing (never the historical PDF of the
--                              existing quote screen): the file, its digest, the content fingerprint of the quote rows
--                              it was rendered from, and display snapshots. Append-only.
--   "QuoteShareEvent"          manual record: downloaded, share sheet opened, marked sent BY THE OWNER, accepted,
--                              declined, note, correction. Append-only; a mistake is corrected by a CORRECTION event,
--                              at most once per event. Nothing here is proof of delivery or of reading.
--   "BusinessLetter"           a saved letter: recipient (customer / supplier link + snapshot), content, its stored
--                              PDF. The owner can hide it (deletedAt); physical removal only through the purge function.
--   "BusinessDocumentErasure"  the durable job record of an account erasure of these tables (object deletion is
--                              finished by the application; the erasure completes only when every file is FENCED).
--
-- PRIVILEGES. Whatever default privileges handed out on the new objects is revoked first; app_runtime then gets:
--   SELECT, INSERT on every table except the erasure job (SELECT only); column-level UPDATE on File (state, digest,
--   lease, times), Request (state, hash, lease, result), Letter (deletedAt, deletedByUserId). No DELETE, no TRUNCATE
--   anywhere. Deleting rows happens only inside the SECURITY DEFINER functions (owned by the migration role), and a
--   second wall — the guard triggers — admits UPDATE/DELETE only from the table owner or a referential action.
--   No transaction-local marker is trusted for that: app_runtime can set any GUC, it can never be the owner.
--
-- RLS. FORCE ROW LEVEL SECURITY with per-command SELECT / INSERT / UPDATE policies keyed on
-- app.current_business_id. No DELETE policy (the runtime never deletes).

-- ── 1. Types ─────────────────────────────────────────────────────────────────────────────────────────

CREATE TYPE "BusinessDocumentFilePurpose" AS ENUM ('QUOTE_SHARE_COPY', 'LETTER');
CREATE TYPE "BusinessDocumentFileState" AS ENUM ('PENDING', 'COMMITTED', 'DELETING', 'FENCED');
CREATE TYPE "BusinessDocumentOperation" AS ENUM ('QUOTE_SHARE_COPY', 'QUOTE_SHARE_EVENT', 'LETTER_SAVE');
CREATE TYPE "BusinessDocumentRequestState" AS ENUM ('ISSUED', 'IN_PROGRESS', 'DONE');
CREATE TYPE "QuoteShareEventKind" AS ENUM ('DOWNLOADED', 'SHARE_SHEET_OPENED', 'MARKED_SENT', 'RESPONSE_ACCEPTED', 'RESPONSE_DECLINED', 'NOTE', 'CORRECTION');
CREATE TYPE "QuoteShareChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'PRINT', 'OTHER');
CREATE TYPE "BusinessLetterRecipientKind" AS ENUM ('CUSTOMER', 'SUPPLIER', 'FREE');
CREATE TYPE "BusinessDocumentErasureState" AS ENUM ('PURGING_OBJECTS', 'DONE');

-- ── 2. Tables ────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "BusinessDocumentFile" (
  "id"          SERIAL NOT NULL,
  "businessId"  INTEGER NOT NULL,
  "purpose"     "BusinessDocumentFilePurpose" NOT NULL,
  "objectKey"   TEXT NOT NULL,
  "state"       "BusinessDocumentFileState" NOT NULL DEFAULT 'PENDING',
  "sha256"      CHAR(64),
  "bytes"       INTEGER,
  "leaseOwner"  UUID,
  "leaseUntil"  TIMESTAMPTZ(3),
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMPTZ(3),
  "fencedAt"    TIMESTAMPTZ(3),
  CONSTRAINT "BusinessDocumentFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessDocumentFile_key_in_business_prefix"
    CHECK ("objectKey" LIKE 'biz/' || "businessId"::text || '/business-docs/%' AND "objectKey" NOT LIKE '%..%' AND char_length("objectKey") <= 300),
  CONSTRAINT "BusinessDocumentFile_sha256_hex" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BusinessDocumentFile_bytes_positive" CHECK ("bytes" IS NULL OR "bytes" > 0),
  CONSTRAINT "BusinessDocumentFile_committed_has_digest"
    CHECK ("state" NOT IN ('COMMITTED') OR ("sha256" IS NOT NULL AND "bytes" IS NOT NULL AND "committedAt" IS NOT NULL)),
  CONSTRAINT "BusinessDocumentFile_fenced_has_time" CHECK ("state" <> 'FENCED' OR "fencedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "BusinessDocumentFile_objectKey_key" ON "BusinessDocumentFile" ("objectKey");
CREATE UNIQUE INDEX "BusinessDocumentFile_businessId_id_key" ON "BusinessDocumentFile" ("businessId", "id");
CREATE INDEX "BusinessDocumentFile_businessId_state_idx" ON "BusinessDocumentFile" ("businessId", "state");
ALTER TABLE "BusinessDocumentFile" ADD CONSTRAINT "BusinessDocumentFile_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessDocumentRequest" (
  "id"             SERIAL NOT NULL,
  "businessId"     INTEGER NOT NULL,
  "operation"      "BusinessDocumentOperation" NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestHash"    CHAR(64),
  "state"          "BusinessDocumentRequestState" NOT NULL DEFAULT 'ISSUED',
  "issuedAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedByUserId" INTEGER,
  "leaseOwner"     UUID,
  "leaseUntil"     TIMESTAMPTZ(3),
  "fileId"         INTEGER,
  "resultId"       INTEGER,
  "completedAt"    TIMESTAMPTZ(3),
  CONSTRAINT "BusinessDocumentRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessDocumentRequest_hash_hex" CHECK ("requestHash" IS NULL OR "requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BusinessDocumentRequest_in_progress_has_lease"
    CHECK ("state" <> 'IN_PROGRESS' OR ("requestHash" IS NOT NULL AND "leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL)),
  CONSTRAINT "BusinessDocumentRequest_done_has_result"
    CHECK ("state" <> 'DONE' OR ("requestHash" IS NOT NULL AND "resultId" IS NOT NULL AND "completedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "BusinessDocumentRequest_businessId_operation_idempotencyKey_key"
  ON "BusinessDocumentRequest" ("businessId", "operation", "idempotencyKey");
CREATE UNIQUE INDEX "BusinessDocumentRequest_businessId_id_key" ON "BusinessDocumentRequest" ("businessId", "id");
CREATE INDEX "BusinessDocumentRequest_businessId_issuedAt_idx" ON "BusinessDocumentRequest" ("businessId", "issuedAt");
ALTER TABLE "BusinessDocumentRequest" ADD CONSTRAINT "BusinessDocumentRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessDocumentRequest" ADD CONSTRAINT "BusinessDocumentRequest_issuedByUserId_fkey"
  FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BusinessDocumentRequest" ADD CONSTRAINT "BusinessDocumentRequest_file_fkey"
  FOREIGN KEY ("businessId", "fileId") REFERENCES "BusinessDocumentFile"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "QuoteShareCopy" (
  "id"                   SERIAL NOT NULL,
  "businessId"           INTEGER NOT NULL,
  "quoteDocumentId"      INTEGER NOT NULL,
  "fileId"               INTEGER NOT NULL,
  "sha256"               CHAR(64) NOT NULL,
  "quoteContentHash"     CHAR(64) NOT NULL,
  "quoteNumberSnapshot"  TEXT NOT NULL,
  "customerNameSnapshot" TEXT,
  "totalSnapshot"        DECIMAL(18,2) NOT NULL,
  "currencySnapshot"     TEXT NOT NULL,
  "validUntilSnapshot"   TIMESTAMP(3),
  "contentCheckedAt"     TIMESTAMPTZ(3) NOT NULL,
  "createdByUserId"      INTEGER,
  "createdAt"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuoteShareCopy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuoteShareCopy_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND "quoteContentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "QuoteShareCopy_snapshot_lengths"
    CHECK (char_length("quoteNumberSnapshot") BETWEEN 1 AND 64
       AND ("customerNameSnapshot" IS NULL OR char_length("customerNameSnapshot") <= 200)
       AND "currencySnapshot" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "QuoteShareCopy_businessId_id_key" ON "QuoteShareCopy" ("businessId", "id");
CREATE UNIQUE INDEX "QuoteShareCopy_businessId_quoteDocumentId_id_key" ON "QuoteShareCopy" ("businessId", "quoteDocumentId", "id");
CREATE UNIQUE INDEX "QuoteShareCopy_businessId_fileId_key" ON "QuoteShareCopy" ("businessId", "fileId");
CREATE INDEX "QuoteShareCopy_businessId_quoteDocumentId_createdAt_idx" ON "QuoteShareCopy" ("businessId", "quoteDocumentId", "createdAt");
ALTER TABLE "QuoteShareCopy" ADD CONSTRAINT "QuoteShareCopy_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteShareCopy" ADD CONSTRAINT "QuoteShareCopy_file_fkey"
  FOREIGN KEY ("businessId", "fileId") REFERENCES "BusinessDocumentFile"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "QuoteShareCopy" ADD CONSTRAINT "QuoteShareCopy_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "QuoteShareEvent" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "quoteDocumentId"  INTEGER NOT NULL,
  "kind"             "QuoteShareEventKind" NOT NULL,
  "copyId"           INTEGER,
  "correctsEventId"  INTEGER,
  "quoteContentHash" CHAR(64) NOT NULL,
  "channel"          "QuoteShareChannel",
  "note"             TEXT,
  "actorUserId"      INTEGER,
  "createdAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuoteShareEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuoteShareEvent_hash_hex" CHECK ("quoteContentHash" ~ '^[0-9a-f]{64}$'),
  -- download / share sheet / marked sent always point at the stored copy they were about
  CONSTRAINT "QuoteShareEvent_copy_iff_file_event" CHECK (("kind" IN ('DOWNLOADED', 'SHARE_SHEET_OPENED', 'MARKED_SENT')) = ("copyId" IS NOT NULL)),
  CONSTRAINT "QuoteShareEvent_correction_iff_target" CHECK (("kind" = 'CORRECTION') = ("correctsEventId" IS NOT NULL)),
  CONSTRAINT "QuoteShareEvent_channel_only_when_sent" CHECK ("channel" IS NULL OR "kind" = 'MARKED_SENT'),
  CONSTRAINT "QuoteShareEvent_note_length" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000),
  CONSTRAINT "QuoteShareEvent_note_required" CHECK ("kind" <> 'NOTE' OR "note" IS NOT NULL)
);
CREATE UNIQUE INDEX "QuoteShareEvent_businessId_id_key" ON "QuoteShareEvent" ("businessId", "id");
CREATE UNIQUE INDEX "QuoteShareEvent_businessId_quoteDocumentId_id_key" ON "QuoteShareEvent" ("businessId", "quoteDocumentId", "id");
-- an event is corrected at most once
CREATE UNIQUE INDEX "QuoteShareEvent_correctsEventId_key" ON "QuoteShareEvent" ("correctsEventId") WHERE "correctsEventId" IS NOT NULL;
CREATE INDEX "QuoteShareEvent_businessId_quoteDocumentId_createdAt_idx" ON "QuoteShareEvent" ("businessId", "quoteDocumentId", "createdAt");
ALTER TABLE "QuoteShareEvent" ADD CONSTRAINT "QuoteShareEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteShareEvent" ADD CONSTRAINT "QuoteShareEvent_copy_fkey"
  FOREIGN KEY ("businessId", "quoteDocumentId", "copyId") REFERENCES "QuoteShareCopy"("businessId", "quoteDocumentId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "QuoteShareEvent" ADD CONSTRAINT "QuoteShareEvent_corrects_fkey"
  FOREIGN KEY ("businessId", "quoteDocumentId", "correctsEventId") REFERENCES "QuoteShareEvent"("businessId", "quoteDocumentId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "QuoteShareEvent" ADD CONSTRAINT "QuoteShareEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BusinessLetter" (
  "id"                    SERIAL NOT NULL,
  "businessId"            INTEGER NOT NULL,
  "recipientKind"         "BusinessLetterRecipientKind" NOT NULL,
  "customerId"            INTEGER,
  "supplierId"            INTEGER,
  "recipientName"         TEXT NOT NULL,
  "recipientAddress"      TEXT NOT NULL DEFAULT '',
  "issuerSnapshot"        JSONB NOT NULL,
  "subject"               TEXT NOT NULL,
  "body"                  TEXT NOT NULL,
  "reference"             TEXT,
  "letterDate"            DATE NOT NULL,
  "signerName"            TEXT,
  "signerTitle"           TEXT,
  "includeSignatureImage" BOOLEAN NOT NULL DEFAULT false,
  "fileId"                INTEGER NOT NULL,
  "sha256"                CHAR(64) NOT NULL,
  "createdByUserId"       INTEGER,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"             TIMESTAMPTZ(3),
  "deletedByUserId"       INTEGER,
  CONSTRAINT "BusinessLetter_pkey" PRIMARY KEY ("id"),
  -- A link may only exist for its own kind. A link may BECOME null (the customer / supplier was deleted:
  -- ON DELETE SET NULL of that column alone) while the recipient snapshot stays — so the CHECK forbids
  -- contradictions only; "a CUSTOMER letter is created with a customer" is the insert trigger's rule.
  CONSTRAINT "BusinessLetter_customer_only_for_customer" CHECK ("customerId" IS NULL OR "recipientKind" = 'CUSTOMER'),
  CONSTRAINT "BusinessLetter_supplier_only_for_supplier" CHECK ("supplierId" IS NULL OR "recipientKind" = 'SUPPLIER'),
  CONSTRAINT "BusinessLetter_lengths"
    CHECK (char_length("recipientName") BETWEEN 1 AND 200
       AND char_length("recipientAddress") <= 500
       AND char_length("subject") BETWEEN 1 AND 200
       AND char_length("body") BETWEEN 1 AND 10000
       AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 60)
       AND ("signerName" IS NULL OR char_length("signerName") BETWEEN 1 AND 120)
       AND ("signerTitle" IS NULL OR char_length("signerTitle") BETWEEN 1 AND 120)),
  CONSTRAINT "BusinessLetter_issuer_is_object" CHECK (jsonb_typeof("issuerSnapshot") = 'object'),
  CONSTRAINT "BusinessLetter_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BusinessLetter_deleted_by_needs_deleted_at" CHECK ("deletedByUserId" IS NULL OR "deletedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "BusinessLetter_businessId_id_key" ON "BusinessLetter" ("businessId", "id");
CREATE UNIQUE INDEX "BusinessLetter_businessId_fileId_key" ON "BusinessLetter" ("businessId", "fileId");
CREATE INDEX "BusinessLetter_businessId_createdAt_idx" ON "BusinessLetter" ("businessId", "createdAt");
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Same business by construction (composite keys); deleting the customer / supplier nulls only the link column.
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_customer_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id") ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION;
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_supplier_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id") ON DELETE SET NULL ("supplierId") ON UPDATE NO ACTION;
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_file_fkey"
  FOREIGN KEY ("businessId", "fileId") REFERENCES "BusinessDocumentFile"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BusinessLetter" ADD CONSTRAINT "BusinessLetter_deletedByUserId_fkey"
  FOREIGN KEY ("deletedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BusinessDocumentErasure" (
  "businessId"  INTEGER NOT NULL,
  "state"       "BusinessDocumentErasureState" NOT NULL DEFAULT 'PURGING_OBJECTS',
  "startedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "BusinessDocumentErasure_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BusinessDocumentErasure_done_has_time" CHECK ("state" <> 'DONE' OR "completedAt" IS NOT NULL)
);
ALTER TABLE "BusinessDocumentErasure" ADD CONSTRAINT "BusinessDocumentErasure_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Guards (SECURITY INVOKER: they run with the caller's privileges and RLS) ───────────────────────

-- The quote link: a QUOTE of the same business (read under the caller's RLS, so another business's document is
-- simply invisible). The Service Desk exclusion (a quote any service-desk quote version references) is the
-- application's rule, checked before every copy, event and reminder: the Service Desk lab forbids any other
-- migration from naming its objects, and this one does not.
CREATE OR REPLACE FUNCTION public.business_documents_quote_link_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."BillingDocument" d
                  WHERE d."id" = NEW."quoteDocumentId" AND d."businessId" = NEW."businessId" AND d."documentType" = 'QUOTE') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD02', MESSAGE = 'BUSINESS_DOCUMENTS_QUOTE_NOT_FOUND: not a quote of this business';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_quote_link_guard() FROM PUBLIC;

-- A row that points at a file needs that file COMMITTED, under FOR SHARE: a concurrent move to DELETING
-- (which takes the row lock) waits for this transaction, or this one waits for it and then sees DELETING.
CREATE OR REPLACE FUNCTION public.business_documents_file_ready_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  f integer;
  s "BusinessDocumentFileState";
BEGIN
  IF TG_TABLE_NAME = 'QuoteShareEvent' THEN
    IF NEW."copyId" IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT c."fileId" INTO f FROM public."QuoteShareCopy" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."copyId";
  ELSE
    f := NEW."fileId";
  END IF;
  SELECT x."state" INTO s FROM public."BusinessDocumentFile" x WHERE x."businessId" = NEW."businessId" AND x."id" = f FOR SHARE;
  IF s IS DISTINCT FROM 'COMMITTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD10', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_NOT_AVAILABLE: the stored file is not available';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_file_ready_guard() FROM PUBLIC;

-- Nothing new for a business that is being erased: a shared advisory lock against the erasure's exclusive one,
-- then the check (an insert that started before the erasure finishes first; one that starts after sees it).
CREATE OR REPLACE FUNCTION public.business_documents_not_erasing()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('business_documents_erasure'), NEW."businessId");
  IF EXISTS (SELECT 1 FROM public."BusinessDocumentErasure" e WHERE e."businessId" = NEW."businessId")
     OR EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = NEW."businessId"
                  AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD20', MESSAGE = 'BUSINESS_DOCUMENTS_BUSINESS_BEING_ERASED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_not_erasing() FROM PUBLIC;

-- The file state machine.
CREATE OR REPLACE FUNCTION public.business_documents_file_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (is_owner AND OLD."state" = 'FENCED') OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZD21', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_DELETE_REFUSED';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD21', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_MUST_START_PENDING';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."state" = 'COMMITTED' AND OLD."state" <> 'COMMITTED') THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('business_documents_erasure'), NEW."businessId");
    IF EXISTS (SELECT 1 FROM public."BusinessDocumentErasure" e WHERE e."businessId" = NEW."businessId")
       OR EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = NEW."businessId"
                    AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD20', MESSAGE = 'BUSINESS_DOCUMENTS_BUSINESS_BEING_ERASED';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW."objectKey" IS DISTINCT FROM OLD."objectKey" OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD22', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW."state" = OLD."state" THEN
    IF OLD."state" IN ('PENDING') THEN
      RETURN NEW;  -- lease refresh
    END IF;
    IF (to_jsonb(NEW) - 'leaseOwner' - 'leaseUntil') = (to_jsonb(OLD) - 'leaseOwner' - 'leaseUntil') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZD24', MESSAGE = format('BUSINESS_DOCUMENTS_FILE_FROZEN in state %s', OLD."state");
  END IF;
  IF (OLD."state", NEW."state") IN (('PENDING', 'COMMITTED'), ('PENDING', 'DELETING'), ('DELETING', 'FENCED')) THEN
    RETURN NEW;
  END IF;
  IF (OLD."state", NEW."state") = ('COMMITTED', 'DELETING') THEN
    -- READ COMMITTED: this statement sees every reference committed while the UPDATE waited for the row lock.
    -- The erasure / purge functions (the owner) mark referenced files too; nothing else may.
    IF NOT is_owner AND (
         EXISTS (SELECT 1 FROM public."QuoteShareCopy" c WHERE c."businessId" = NEW."businessId" AND c."fileId" = NEW."id")
      OR EXISTS (SELECT 1 FROM public."BusinessLetter" l WHERE l."businessId" = NEW."businessId" AND l."fileId" = NEW."id")) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD23', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_STILL_REFERENCED';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD24', MESSAGE = format('BUSINESS_DOCUMENTS_FILE_TRANSITION_REFUSED %s -> %s', OLD."state", NEW."state");
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_file_guard() FROM PUBLIC;

-- Append-only (QuoteShareCopy, QuoteShareEvent). DELETE: only the table owner (inside the erasure function) or a
-- cascade from Business. UPDATE: only the referential action nulling the user column named in TG_ARGV[0].
CREATE OR REPLACE FUNCTION public.business_documents_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF is_owner OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1 AND (to_jsonb(NEW) ->> TG_ARGV[0]) IS NULL
       AND (to_jsonb(NEW) - TG_ARGV[0]) = (to_jsonb(OLD) - TG_ARGV[0]) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD30', MESSAGE = format('BUSINESS_DOCUMENTS_APPEND_ONLY: %s on %I is refused', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.business_documents_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DZD30', MESSAGE = format('BUSINESS_DOCUMENTS_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_truncate_guard() FROM PUBLIC;

-- A correction targets a "sent" or a response, never a note, a download, a share sheet or another correction.
CREATE OR REPLACE FUNCTION public.business_documents_correction_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  target "QuoteShareEventKind";
BEGIN
  IF NEW."kind" <> 'CORRECTION' THEN
    RETURN NEW;
  END IF;
  SELECT e."kind" INTO target FROM public."QuoteShareEvent" e
   WHERE e."businessId" = NEW."businessId" AND e."quoteDocumentId" = NEW."quoteDocumentId" AND e."id" = NEW."correctsEventId";
  IF target IS NULL OR target NOT IN ('MARKED_SENT', 'RESPONSE_ACCEPTED', 'RESPONSE_DECLINED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'BUSINESS_DOCUMENTS_CORRECTION_TARGET_REFUSED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_correction_guard() FROM PUBLIC;

-- A letter is created with the link its kind needs (the FK makes it the same business).
CREATE OR REPLACE FUNCTION public.business_letter_recipient_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF (NEW."recipientKind" = 'CUSTOMER' AND (NEW."customerId" IS NULL OR NEW."supplierId" IS NOT NULL))
     OR (NEW."recipientKind" = 'SUPPLIER' AND (NEW."supplierId" IS NULL OR NEW."customerId" IS NOT NULL))
     OR (NEW."recipientKind" = 'FREE' AND (NEW."customerId" IS NOT NULL OR NEW."supplierId" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD40', MESSAGE = 'BUSINESS_LETTER_RECIPIENT_LINK_REQUIRED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_letter_recipient_guard() FROM PUBLIC;

-- A saved letter never changes. Admitted: the owner hiding it once (deletedAt + deletedByUserId from NULL);
-- a referential action nulling a link or a user column; DELETE by the table owner (purge / erasure functions) or a
-- cascade from Business.
CREATE OR REPLACE FUNCTION public.business_letter_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  nullable constant text[] := ARRAY['customerId', 'supplierId', 'createdByUserId', 'deletedByUserId'];
  col text;
  rest_same boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF is_owner OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZD41', MESSAGE = 'BUSINESS_LETTER_DELETE_REFUSED';
  END IF;
  -- the owner hides it, once
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'deletedAt' - 'deletedByUserId') = (to_jsonb(OLD) - 'deletedAt' - 'deletedByUserId') THEN
    RETURN NEW;
  END IF;
  -- a referential action: one of the nullable link / user columns to NULL, nothing else
  IF pg_trigger_depth() > 1 THEN
    FOREACH col IN ARRAY nullable LOOP
      rest_same := (to_jsonb(NEW) - col) = (to_jsonb(OLD) - col);
      IF rest_same AND (to_jsonb(NEW) ->> col) IS NULL THEN
        RETURN NEW;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD41', MESSAGE = 'BUSINESS_LETTER_IMMUTABLE: a saved letter cannot be changed';
END
$fn$;
REVOKE ALL ON FUNCTION public.business_letter_guard() FROM PUBLIC;

CREATE TRIGGER "BusinessDocumentFile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BusinessDocumentFile"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_file_guard();
CREATE TRIGGER "BusinessDocumentFile_no_truncate" BEFORE TRUNCATE ON "BusinessDocumentFile"
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_documents_truncate_guard();

CREATE TRIGGER "BusinessDocumentRequest_not_erasing" BEFORE INSERT ON "BusinessDocumentRequest"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_not_erasing();

CREATE TRIGGER "QuoteShareCopy_not_erasing" BEFORE INSERT ON "QuoteShareCopy"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_not_erasing();
CREATE TRIGGER "QuoteShareCopy_quote_link" BEFORE INSERT ON "QuoteShareCopy"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_quote_link_guard();
CREATE TRIGGER "QuoteShareCopy_file_ready" BEFORE INSERT ON "QuoteShareCopy"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_file_ready_guard();
CREATE TRIGGER "QuoteShareCopy_append_only" BEFORE UPDATE OR DELETE ON "QuoteShareCopy"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_append_only_guard('createdByUserId');
CREATE TRIGGER "QuoteShareCopy_no_truncate" BEFORE TRUNCATE ON "QuoteShareCopy"
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_documents_truncate_guard();

CREATE TRIGGER "QuoteShareEvent_not_erasing" BEFORE INSERT ON "QuoteShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_not_erasing();
CREATE TRIGGER "QuoteShareEvent_quote_link" BEFORE INSERT ON "QuoteShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_quote_link_guard();
CREATE TRIGGER "QuoteShareEvent_file_ready" BEFORE INSERT ON "QuoteShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_file_ready_guard();
CREATE TRIGGER "QuoteShareEvent_correction" BEFORE INSERT ON "QuoteShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_correction_guard();
CREATE TRIGGER "QuoteShareEvent_append_only" BEFORE UPDATE OR DELETE ON "QuoteShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_append_only_guard('actorUserId');
CREATE TRIGGER "QuoteShareEvent_no_truncate" BEFORE TRUNCATE ON "QuoteShareEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_documents_truncate_guard();

CREATE TRIGGER "BusinessLetter_not_erasing" BEFORE INSERT ON "BusinessLetter"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_not_erasing();
CREATE TRIGGER "BusinessLetter_recipient" BEFORE INSERT ON "BusinessLetter"
  FOR EACH ROW EXECUTE FUNCTION public.business_letter_recipient_guard();
CREATE TRIGGER "BusinessLetter_file_ready" BEFORE INSERT ON "BusinessLetter"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_file_ready_guard();
CREATE TRIGGER "BusinessLetter_guard" BEFORE UPDATE OR DELETE ON "BusinessLetter"
  FOR EACH ROW EXECUTE FUNCTION public.business_letter_guard();
CREATE TRIGGER "BusinessLetter_no_truncate" BEFORE TRUNCATE ON "BusinessLetter"
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_documents_truncate_guard();

-- ── 4. Account erasure of these tables — defined, NOT connected to account deletion (not approved) ─────

-- No parameter: the business is the tenant context, and only while it is being deleted. Files first (waiting for
-- any in-flight insert holding FOR SHARE on one), then every record, all under the exclusive advisory lock that
-- every insert takes shared. The durable job row is written in the same transaction as the destruction.
CREATE OR REPLACE FUNCTION public.business_documents_erase()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_files integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD50', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD51', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('business_documents_erasure'), v_business);
  INSERT INTO public."BusinessDocumentErasure" ("businessId", "state") VALUES (v_business, 'PURGING_OBJECTS')
    ON CONFLICT ("businessId") DO NOTHING;
  UPDATE public."BusinessDocumentFile" SET "state" = 'DELETING', "leaseOwner" = NULL, "leaseUntil" = NULL
   WHERE "businessId" = v_business AND "state" IN ('PENDING', 'COMMITTED');
  GET DIAGNOSTICS v_files = ROW_COUNT;
  DELETE FROM public."QuoteShareEvent" WHERE "businessId" = v_business AND "correctsEventId" IS NOT NULL;
  DELETE FROM public."QuoteShareEvent" WHERE "businessId" = v_business;
  DELETE FROM public."QuoteShareCopy" WHERE "businessId" = v_business;
  DELETE FROM public."BusinessLetter" WHERE "businessId" = v_business;
  DELETE FROM public."BusinessDocumentRequest" WHERE "businessId" = v_business;
  -- Silent-zero proof: a role without the privilege to see the rows would have deleted nothing and said so quietly.
  IF EXISTS (SELECT 1 FROM public."QuoteShareEvent" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."QuoteShareCopy" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessLetter" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessDocumentRequest" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessDocumentFile" WHERE "businessId" = v_business AND "state" IN ('PENDING', 'COMMITTED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD52', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_INCOMPLETE: rows remain; rolled back';
  END IF;
  RETURN v_files;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_erase() FROM PUBLIC;

-- Completes the erasure only when every file of the business is FENCED (its object deleted and its key closed by a
-- create-once marker). Returns false — and changes nothing — while any file is not.
CREATE OR REPLACE FUNCTION public.business_documents_erasure_complete()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer;
BEGIN
  IF v_business IS NULL OR NOT EXISTS (SELECT 1 FROM public."BusinessDocumentErasure" e
                                        WHERE e."businessId" = v_business AND e."state" = 'PURGING_OBJECTS') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD53', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_NOT_RUNNING';
  END IF;
  IF EXISTS (SELECT 1 FROM public."BusinessDocumentFile" f WHERE f."businessId" = v_business AND f."state" <> 'FENCED') THEN
    RETURN false;
  END IF;
  DELETE FROM public."BusinessDocumentFile" WHERE "businessId" = v_business;
  UPDATE public."BusinessDocumentErasure" SET "state" = 'DONE', "completedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "state" = 'PURGING_OBJECTS';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 OR EXISTS (SELECT 1 FROM public."BusinessDocumentFile" WHERE "businessId" = v_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD52', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_INCOMPLETE: rows remain; rolled back';
  END IF;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_erasure_complete() FROM PUBLIC;

-- ── 5. Physical removal of ONE hidden letter — defined, nothing calls it (retention is not approved) ──────

-- The age is an explicit argument with no default; the caller is the tenant context. The letter's file goes to
-- DELETING; the application then fences it.
CREATE OR REPLACE FUNCTION public.business_documents_purge_letter(p_letter_id integer, p_min_hidden_days integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_file integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD60', MESSAGE = 'BUSINESS_DOCUMENTS_PURGE_NO_CONTEXT';
  END IF;
  IF p_min_hidden_days IS NULL OR p_min_hidden_days < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD61', MESSAGE = 'BUSINESS_DOCUMENTS_PURGE_AGE_REQUIRED: an explicit age of at least one day';
  END IF;
  SELECT l."fileId" INTO v_file FROM public."BusinessLetter" l
   WHERE l."businessId" = v_business AND l."id" = p_letter_id
     AND l."deletedAt" IS NOT NULL AND l."deletedAt" <= CURRENT_TIMESTAMP - make_interval(days => p_min_hidden_days)
   FOR UPDATE;
  IF v_file IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD62', MESSAGE = 'BUSINESS_DOCUMENTS_PURGE_NOT_ELIGIBLE: not a hidden letter of this business old enough';
  END IF;
  UPDATE public."BusinessDocumentFile" SET "state" = 'DELETING', "leaseOwner" = NULL, "leaseUntil" = NULL
   WHERE "businessId" = v_business AND "id" = v_file AND "state" = 'COMMITTED';
  DELETE FROM public."BusinessLetter" WHERE "businessId" = v_business AND "id" = p_letter_id;
  IF EXISTS (SELECT 1 FROM public."BusinessLetter" WHERE "businessId" = v_business AND "id" = p_letter_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD52', MESSAGE = 'BUSINESS_DOCUMENTS_PURGE_INCOMPLETE: rolled back';
  END IF;
  RETURN v_file;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_purge_letter(integer, integer) FROM PUBLIC;

-- ── 6. Row-level security ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "BusinessDocumentFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessDocumentFile" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_document_file_tenant_select ON "BusinessDocumentFile" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_document_file_tenant_insert ON "BusinessDocumentFile" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_document_file_tenant_update ON "BusinessDocumentFile" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessDocumentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessDocumentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_document_request_tenant_select ON "BusinessDocumentRequest" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_document_request_tenant_insert ON "BusinessDocumentRequest" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_document_request_tenant_update ON "BusinessDocumentRequest" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "QuoteShareCopy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuoteShareCopy" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_share_copy_tenant_select ON "QuoteShareCopy" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY quote_share_copy_tenant_insert ON "QuoteShareCopy" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "QuoteShareEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuoteShareEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_share_event_tenant_select ON "QuoteShareEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY quote_share_event_tenant_insert ON "QuoteShareEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessLetter" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_letter_tenant_select ON "BusinessLetter" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_letter_tenant_insert ON "BusinessLetter" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_letter_tenant_update ON "BusinessLetter" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessDocumentErasure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessDocumentErasure" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_document_erasure_tenant_select ON "BusinessDocumentErasure" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ─────────────────────────────────────────────────────────────────

REVOKE ALL ON "BusinessDocumentFile", "BusinessDocumentRequest", "QuoteShareCopy", "QuoteShareEvent",
              "BusinessLetter", "BusinessDocumentErasure" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "BusinessDocumentFile_id_seq", "BusinessDocumentRequest_id_seq", "QuoteShareCopy_id_seq",
              "QuoteShareEvent_id_seq", "BusinessLetter_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('BusinessDocumentFile', 'BusinessDocumentRequest', 'QuoteShareCopy', 'QuoteShareEvent',
                         'BusinessLetter', 'BusinessDocumentErasure',
                         'BusinessDocumentFile_id_seq', 'BusinessDocumentRequest_id_seq', 'QuoteShareCopy_id_seq',
                         'QuoteShareEvent_id_seq', 'BusinessLetter_id_seq')
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

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "BusinessDocumentFile" TO app_runtime;
    GRANT UPDATE ("state", "sha256", "bytes", "leaseOwner", "leaseUntil", "committedAt", "fencedAt") ON "BusinessDocumentFile" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessDocumentFile_id_seq" TO app_runtime;

    GRANT SELECT, INSERT ON "BusinessDocumentRequest" TO app_runtime;
    GRANT UPDATE ("state", "requestHash", "leaseOwner", "leaseUntil", "fileId", "resultId", "completedAt") ON "BusinessDocumentRequest" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessDocumentRequest_id_seq" TO app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "QuoteShareCopy" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "QuoteShareCopy_id_seq" TO app_runtime;
    GRANT SELECT, INSERT ON "QuoteShareEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "QuoteShareEvent_id_seq" TO app_runtime;

    -- A saved letter: read, add, hide.
    GRANT SELECT, INSERT ON "BusinessLetter" TO app_runtime;
    GRANT UPDATE ("deletedAt", "deletedByUserId") ON "BusinessLetter" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessLetter_id_seq" TO app_runtime;

    GRANT SELECT ON "BusinessDocumentErasure" TO app_runtime;

    GRANT EXECUTE ON FUNCTION public.business_documents_erase() TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.business_documents_erasure_complete() TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.business_documents_purge_letter(integer, integer) TO app_runtime;
  END IF;
END
$do$;

-- ── 8. The flag — OFF ────────────────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('business_documents', 'מסמכים נוספים', 'documents', 'מעקב הצעות מחיר, מכתבים וציר מסמכים לכל לקוח — לקריאה ולתיעוד בלבד, ללא שינוי בחשבוניות — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('business_documents', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
