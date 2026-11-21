-- ============================================================================
-- LAB CHECK for billing-line-base-document-v1.DRAFT.sql — synthetic, throwaway DB.
-- Run AFTER the draft was applied (the runner records relfilenode before/after separately).
-- Checks run as the owner except where stated; each prints PASS/FAIL.
-- ============================================================================
\set QUIET on
CREATE OR REPLACE FUNCTION pg_temp.expect(label text, sqltext text, want text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE got text := 'OK';
BEGIN
  BEGIN EXECUTE sqltext; EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM; END;
  IF (want = 'OK' AND got = 'OK') OR (want <> 'OK' AND got LIKE '%' || want || '%') THEN
    RAISE NOTICE 'PASS  %', label;
  ELSE
    RAISE NOTICE 'FAIL  % — got: %', label, got;
  END IF;
END $f$;

INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES (940001,'bd-lab',now(),now());
INSERT INTO "BillingDocument"("id","businessId","documentType","status","customerNameSnapshot","currency","subtotalAmount","vatAmount","totalAmount","createdAt","updatedAt")
  VALUES (941001,940001,'TAX_INVOICE','DRAFT','x','ILS',100,18,118,now(),now()),
         (941002,940001,'TAX_INVOICE','DRAFT','x','ILS',100,18,118,now(),now());

\set line 'INSERT INTO "BillingDocumentLine"("billingDocumentId","lineIndex","description","quantity","unitPrice","vatRatePercent","lineSubtotal","vatAmount","lineTotal","updatedAt"'

SELECT pg_temp.expect('C1 a line with no reference (today''s shape) is accepted',
  :'line' || $$) VALUES (941001,0,'שורה',1,100,18,100,18,118,now())$$, 'OK');
SELECT pg_temp.expect('C2 a line with a full reference (200, number, date) is accepted',
  :'line' || $$,"baseDocTypeCode","baseDocNumber","baseDocDate","baseDocSourceKind","baseDocSourceId") VALUES (941001,1,'שורה',1,100,18,100,18,118,now(),'200','DN-000123','2026-11-01','DELIVERY_NOTE',77)$$, 'OK');
SELECT pg_temp.expect('C3 a partial reference (type without number) is refused',
  :'line' || $$,"baseDocTypeCode") VALUES (941001,2,'שורה',1,100,18,100,18,118,now(),'200')$$, 'BillingDocumentLine_baseDoc_all_or_none');
SELECT pg_temp.expect('C4 a type code outside the contract (e.g. 400) is refused',
  :'line' || $$,"baseDocTypeCode","baseDocNumber","baseDocDate") VALUES (941001,3,'שורה',1,100,18,100,18,118,now(),'400','R-1','2026-11-01')$$, 'BillingDocumentLine_baseDoc_values');
SELECT pg_temp.expect('C5 a number longer than 20 characters is refused',
  :'line' || $$,"baseDocTypeCode","baseDocNumber","baseDocDate") VALUES (941001,4,'שורה',1,100,18,100,18,118,now(),'200','123456789012345678901','2026-11-01')$$, 'value too long');
SELECT pg_temp.expect('C6 a source without a reference is refused (navigation only accompanies a reference)',
  :'line' || $$,"baseDocSourceKind","baseDocSourceId") VALUES (941001,5,'שורה',1,100,18,100,18,118,now(),'DELIVERY_NOTE',77)$$, 'BillingDocumentLine_baseDoc_source_pair');
SELECT pg_temp.expect('C7 a blank number is refused',
  :'line' || $$,"baseDocTypeCode","baseDocNumber","baseDocDate") VALUES (941001,6,'שורה',1,100,18,100,18,118,now(),'200','   ','2026-11-01')$$, 'BillingDocumentLine_baseDoc_values');

SELECT pg_temp.expect('C7b precondition: lines 0 and 1 exist (so C8/C9 are not vacuous)', $q$SELECT 1/(CASE WHEN count(*) = 2 THEN 1 ELSE 0 END) FROM "BillingDocumentLine" WHERE "billingDocumentId" = 941001 AND "lineIndex" IN (0,1)$q$, 'OK');
-- the existing immutability trigger covers the new columns: once the document is ISSUED, nothing changes
UPDATE "BillingDocument" SET "status" = 'ISSUED', "issuedAt" = now() WHERE "id" = 941001;
SELECT pg_temp.expect('C8 after issue, changing a line''s reference is refused by the existing fiscal-immutability trigger',
  $q$UPDATE "BillingDocumentLine" SET "baseDocNumber" = 'DN-999' WHERE "billingDocumentId" = 941001 AND "lineIndex" = 1$q$, 'FISCAL_IMMUTABLE');
SELECT pg_temp.expect('C9 after issue, adding a reference to an existing line is refused',
  $q$UPDATE "BillingDocumentLine" SET "baseDocTypeCode"='200',"baseDocNumber"='X',"baseDocDate"='2026-11-01' WHERE "billingDocumentId" = 941001 AND "lineIndex" = 0$q$, 'FISCAL_IMMUTABLE');
SELECT pg_temp.expect('C10 existing rows read back with all five columns NULL (no backfill)',
  $q$SELECT 1/(CASE WHEN count(*) = 0 THEN 1 ELSE 0 END) FROM "BillingDocumentLine" WHERE "billingDocumentId" = 941001 AND "lineIndex" = 0 AND ("baseDocTypeCode" IS NOT NULL OR "baseDocNumber" IS NOT NULL OR "baseDocDate" IS NOT NULL OR "baseDocSourceKind" IS NOT NULL OR "baseDocSourceId" IS NOT NULL)$q$, 'OK');
