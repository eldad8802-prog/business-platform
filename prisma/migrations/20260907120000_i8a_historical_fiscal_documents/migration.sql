-- I-8A — historical fiscal documents: inert persistence.
--
-- WHAT THIS IS FOR
-- A business arriving at Dubiz usually has years of invoices and receipts that
-- another system issued. They should be able to keep that history here. What
-- they must NOT get is history that looks like Dubiz issued it.
--
-- `BillingDocument` means exactly one thing: Dubiz produced this document. It
-- carries a number drawn from Dubiz's own sequence, an issuance snapshot and
-- legal hash, a Dubiz-rendered and sometimes cryptographically signed PDF, and
-- it is the table the uniform (מבנה אחיד) export files with the Tax Authority.
-- Putting somebody else's invoice in there would make every one of those
-- statements false, and the uniform export would file it.
--
-- So this table is separate, and nothing here touches billing. No column of
-- BillingDocument changes. No number is drawn. No sequence is read or written.
-- No FinancialEvent, no authority submission, no PDF.
--
-- WHAT IS DELIBERATELY ABSENT
--   * no status/DRAFT/ISSUED — this is not an issuance state machine, and
--     copying that vocabulary is how a historical record starts being treated
--     like an issued one
--   * no line items — the import contract that would produce them does not
--     exist yet, and the line detail is preserved in the original artifact.
--     Adding an empty table now would be persistence with no producer
--   * no structured payment data — reusing BillingReceiptPayment would assert
--     Dubiz saw those payments; a separate design comes with its own increment
--   * no allocationNumber — `originalAllocationNumber` is named for what it is:
--     a number somebody ELSE obtained, which Dubiz never requested, validated
--     or reported
--
-- EXPAND-ONLY. One new table, one added index on Document, foreign keys,
-- policies and grants. No column is altered or dropped, no data is written, and
-- nothing here depends on the state of any particular database.

-- ============================================================
-- Table
-- ============================================================
CREATE TABLE "HistoricalFiscalDocument" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "documentTypeCode" TEXT NOT NULL,
    "sourceDocumentTypeRaw" TEXT,
    "originalDocumentNumber" TEXT,
    "originalIssueDate" TIMESTAMP(3),
    "subtotalAmount" DECIMAL(18,2),
    "vatAmount" DECIMAL(18,2),
    "totalAmount" DECIMAL(18,2),
    "currency" TEXT,
    "customerNameSnapshot" TEXT,
    "customerTaxIdSnapshot" TEXT,
    "customerAddressSnapshot" TEXT,
    "customerEmailSnapshot" TEXT,
    "customerPhoneSnapshot" TEXT,
    "sourceSystemCode" TEXT NOT NULL,
    "sourceSystemNameRaw" TEXT,
    "originalAllocationNumber" TEXT,
    "documentId" INTEGER,
    "reversesHistoricalDocumentId" INTEGER,
    "reversesOriginalNumberRaw" TEXT,
    "importRunId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalFiscalDocument_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- Indexes
--
-- The fiscal-identity index is an INDEX and NOT a unique constraint, on
-- purpose. Business + source system + type + original number looks like an
-- identity and mostly is, but every one of these is legitimate: a source
-- exporting a corrected row twice, a document that genuinely has no number, an
-- owner relabelling which system a batch came from, and two prior systems both
-- numbering an invoice 1001. A database uniqueness rule would turn each of them
-- into an import failure the owner cannot resolve. Duplicate handling belongs
-- to the import contract, which can show the owner what it found and ask.
-- ============================================================
CREATE INDEX "HistoricalFiscalDocument_businessId_originalIssueDate_idx" ON "HistoricalFiscalDocument"("businessId", "originalIssueDate");
CREATE INDEX "HistoricalFiscalDocument_businessId_sourceSystemCode_idx" ON "HistoricalFiscalDocument"("businessId", "sourceSystemCode");
CREATE INDEX "HistoricalFiscalDocument_businessId_sourceSystemCode_docume_idx" ON "HistoricalFiscalDocument"("businessId", "sourceSystemCode", "documentTypeCode", "originalDocumentNumber");
CREATE INDEX "HistoricalFiscalDocument_businessId_documentId_idx" ON "HistoricalFiscalDocument"("businessId", "documentId");
CREATE INDEX "HistoricalFiscalDocument_businessId_reversesHistoricalDocum_idx" ON "HistoricalFiscalDocument"("businessId", "reversesHistoricalDocumentId");
CREATE INDEX "HistoricalFiscalDocument_importRunId_idx" ON "HistoricalFiscalDocument"("importRunId");

-- The composite key the tenant-scoped relations point at. Its only job is to
-- make a cross-tenant reference impossible to represent.
CREATE UNIQUE INDEX "HistoricalFiscalDocument_businessId_id_key" ON "HistoricalFiscalDocument"("businessId", "id");

-- The same, on Document. An index and nothing else: no column is added, no
-- Document behaviour changes, and no existing query is affected. It exists so a
-- historical record can only attach to an artifact of its OWN tenant, enforced
-- by the database rather than by a check somebody has to remember to write.
CREATE UNIQUE INDEX "Document_businessId_id_key" ON "Document"("businessId", "id");

-- ============================================================
-- Foreign keys
--
-- RESTRICT on the artifact and the reversal reference, not SET NULL. A composite
-- key that includes the required `businessId` cannot be set to null, and the
-- rule is truer this way: an original artifact must not be able to vanish from
-- under the historical record that describes it. `Document` is already a
-- must-retain model, so this forbids nothing the product does today.
--
-- The import link points at the RUN and not at a row marker. Markers are cleaned
-- up after their retry window; provenance has to outlive them. SET NULL there
-- because it is a single nullable column and losing the link must never take the
-- historical record with it.
-- ============================================================
ALTER TABLE "HistoricalFiscalDocument" ADD CONSTRAINT "HistoricalFiscalDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HistoricalFiscalDocument" ADD CONSTRAINT "HistoricalFiscalDocument_businessId_documentId_fkey" FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HistoricalFiscalDocument" ADD CONSTRAINT "HistoricalFiscalDocument_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HistoricalFiscalDocument" ADD CONSTRAINT "HistoricalFiscalDocument_businessId_reversesHistoricalDocu_fkey" FOREIGN KEY ("businessId", "reversesHistoricalDocumentId") REFERENCES "HistoricalFiscalDocument"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A document cannot reverse itself. Cheap to state, and the kind of thing that
-- is obvious right up until an import maps a row onto its own id.
ALTER TABLE "HistoricalFiscalDocument" ADD CONSTRAINT "HistoricalFiscalDocument_no_self_reversal"
  CHECK ("reversesHistoricalDocumentId" IS NULL OR "reversesHistoricalDocumentId" <> "id");

-- ============================================================
-- Row-level security — canonical D2/P7 shape
--
-- SELECT and INSERT only. No UPDATE policy and no DELETE policy, because
-- nothing updates or deletes these rows: a historical record is what the owner
-- confirmed at import, and the product has no operation that edits it. If
-- resolving a reversal reference later needs an UPDATE, that is an explicit,
-- reviewable addition rather than a capability granted in advance.
--
-- No admin policy either: there is no platform-admin consumer of this table.
-- Zero consumers, zero privilege.
-- ============================================================
ALTER TABLE "HistoricalFiscalDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HistoricalFiscalDocument" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS i8a_hist_tenant_read ON "HistoricalFiscalDocument";
CREATE POLICY i8a_hist_tenant_read ON "HistoricalFiscalDocument" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS i8a_hist_tenant_insert ON "HistoricalFiscalDocument";
CREATE POLICY i8a_hist_tenant_insert ON "HistoricalFiscalDocument" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Grants
--
-- Only what has a consumer. The runtime reads and inserts; it never updates or
-- deletes, so it is granted neither.
--
-- The REVOKEs are not decoration. This project's databases carry ALTER DEFAULT
-- PRIVILEGES handing app_runtime a,r,w,d on every NEW table, so this one arrives
-- holding UPDATE and DELETE that nobody asked for. RLS would refuse them anyway
-- for want of a policy, but immutability should not rest on one mechanism, and
-- the grant and the policy should agree.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "HistoricalFiscalDocument" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "HistoricalFiscalDocument_id_seq" TO app_runtime;

    REVOKE UPDATE ON "HistoricalFiscalDocument" FROM app_runtime;
    REVOKE DELETE ON "HistoricalFiscalDocument" FROM app_runtime;
  END IF;
END
$$;
