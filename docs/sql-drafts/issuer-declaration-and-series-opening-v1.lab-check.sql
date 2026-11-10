-- ============================================================================
-- LAB CHECK for issuer-declaration-and-series-opening-v1.DRAFT.sql — synthetic data, throwaway DB.
-- Fixtures are written by the OWNER; the checks run as decl_lab_rt, a NOSUPERUSER NOBYPASSRLS login
-- that is a member of app_runtime (SET ROLE). Each check prints PASS/FAIL; a FAIL is a design defect.
--   psql <owner url of a throwaway DB where the draft was applied> -v ON_ERROR_STOP=1 -f this-file
-- ============================================================================
\set QUIET on
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'decl_lab_rt') THEN
  CREATE ROLE decl_lab_rt LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE app_runtime; END IF; END $$;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON "BillingDocument", "BillingDocumentNumberSequence" TO app_runtime;

INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES (910001,'decl-lab-1',now(),now()),(910002,'decl-lab-2',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt")
  VALUES (920001,'decl1@example.test','x',910001,'USER',now(),now()),(920002,'decl2@example.test','x',910002,'USER',now(),now());
-- business 2 already used its RECEIPT series (counter exists)
INSERT INTO "BillingDocumentNumberSequence"("businessId","documentType","nextNumber","createdAt","updatedAt") VALUES (910002,'RECEIPT',5,now(),now());

-- pg_temp.decl(...) builds one declaration INSERT; supersedes = the business's version (v - 1) when v > 1
CREATE OR REPLACE FUNCTION pg_temp.decl(b int, v int, kind text, track text, form text, vat text, lname text,
                                        idtype text, idnum text, vatnum text, addr text, u int)
RETURNS text LANGUAGE sql AS $f$
  SELECT format(
    'INSERT INTO "BusinessIssuerDeclaration"("businessId","version","supersedesId","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt") '
    'SELECT %s,%s,%s,%L,%L,%L,%L,%L,%L,%L,%s,%L,''0500000000'',''lab@example.test'',now(),%s,''בעל העסק לבדיקה'',''בעל העסק'',''issuer-declaration-he-v1'',repeat(''a'',64),''EMAIL_CODE'',now()',
    b, v,
    CASE WHEN v = 1 THEN 'NULL' ELSE format('(SELECT "id" FROM "BusinessIssuerDeclaration" WHERE "businessId"=%s AND "version"=%s)', b, v - 1) END,
    kind, track, form, vat, lname, idtype, idnum,
    CASE WHEN vatnum IS NULL THEN 'NULL' ELSE quote_literal(vatnum) END,
    addr, u)
$f$;

-- pg_temp.opening(...) inserts one opening and REQUIRES exactly one row (a 0-row insert is a FAIL, never a pass)
CREATE OR REPLACE FUNCTION pg_temp.opening(b int, dtype text, num int, src text, tool text, lastnum int, u int)
RETURNS text LANGUAGE sql AS $f$
  SELECT format(
    'DO $d$ DECLARE n int; BEGIN '
    'INSERT INTO "BillingSeriesOpening"("businessId","documentType","seriesCode","openingNumber","source","previousToolName","lastNumberInPreviousTool","declarationId","declaredByUserId") '
    'SELECT %s,%L,''MAIN'',%s,%L,%s,%s,(SELECT max("id") FROM "BusinessIssuerDeclaration" WHERE "businessId"=%s),%s; '
    'GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION ''expected 1 row, got %%'', n; END IF; END $d$',
    b, dtype, num, src,
    CASE WHEN tool IS NULL THEN 'NULL' ELSE quote_literal(tool) END,
    CASE WHEN lastnum IS NULL THEN 'NULL' ELSE lastnum::text END,
    b, u)
$f$;

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

SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);

SELECT pg_temp.expect('D1 first declaration (authorized dealer, individual) is accepted',
  pg_temp.decl(910001,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 1',920001), 'OK');
SELECT pg_temp.expect('D2 a track that does not match its legal form / VAT status is refused',
  pg_temp.decl(910001,2,'CORRECTION','COMPANY_AUTHORIZED_DEALER','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 1',920001), 'IssuerDeclaration_track_shape');
SELECT pg_temp.expect('D3 an authorized dealer without a VAT registration number is refused',
  pg_temp.decl(910001,2,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018',NULL,'רחוב 2',920001), 'IssuerDeclaration_vat_number');
SELECT pg_temp.expect('D4 skipping the chain (version 3 while the current is 1) is refused',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001), 'ISSUER_DECLARATION_MUST_SUPERSEDE_CURRENT');
SELECT pg_temp.expect('D5 a contact update (new address) superseding v1 is accepted',
  pg_temp.decl(910001,2,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001), 'OK');
SELECT pg_temp.expect('D6 a contact update that changes the legal name is refused',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','שם אחר','ISRAELI_ID','000000018','000000018','רחוב 2',920001), 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY');
SELECT pg_temp.expect('D7 becoming a company (new legal person, new number) inside the business is refused',
  pg_temp.decl(910001,3,'STATUS_CHANGE','COMPANY_AUTHORIZED_DEALER','COMPANY','AUTHORIZED','חברה בע"מ','COMPANY_NUMBER','516000004','516000004','רחוב 2',920001), 'ISSUER_IDENTITY_IS_LOCKED');
SELECT pg_temp.expect('D8 a "status change" that does not change the VAT status is refused',
  pg_temp.decl(910001,3,'STATUS_CHANGE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001), 'ISSUER_STATUS_CHANGE_INVALID');
SELECT pg_temp.expect('D9 UPDATE of a declaration is refused for the runtime',
  $q$UPDATE "BusinessIssuerDeclaration" SET "address"='x' WHERE "businessId"=910001$q$, 'permission denied');
SELECT pg_temp.expect('D10 DELETE of a declaration is refused for the runtime',
  $q$DELETE FROM "BusinessIssuerDeclaration" WHERE "businessId"=910001$q$, 'permission denied');
SELECT pg_temp.expect('D11 a declaration for ANOTHER business is refused by RLS',
  pg_temp.decl(910002,1,'INITIAL','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000026',NULL,'רחוב 1',920002), 'row-level security');

SELECT pg_temp.expect('O1 continuing a previous tool: opening 459 after last 458 is accepted',
  pg_temp.opening(910001,'TAX_INVOICE',459,'CONTINUES_PREVIOUS_TOOL','ספר ידני',458,920001), 'OK');
SELECT pg_temp.expect('O2 a second opening for the same series is refused',
  pg_temp.opening(910001,'TAX_INVOICE',1,'NEW_BUSINESS',NULL,NULL,920001), 'BillingSeriesOpening_series_key');
SELECT pg_temp.expect('O3 NEW_BUSINESS with an opening other than 1 is refused',
  pg_temp.opening(910001,'RECEIPT',7,'NEW_BUSINESS',NULL,NULL,920001), 'SeriesOpening_source_shape');
SELECT pg_temp.expect('O4 an opening that does not follow the previous tool''s last number is refused',
  pg_temp.opening(910001,'RECEIPT',100,'CONTINUES_PREVIOUS_TOOL','תוכנה קודמת',458,920001), 'SeriesOpening_source_shape');
SELECT pg_temp.expect('O5 NEW_BUSINESS opening 1 for an unused series is accepted',
  pg_temp.opening(910001,'RECEIPT',1,'NEW_BUSINESS',NULL,NULL,920001), 'OK');
SELECT pg_temp.expect('O6 UPDATE of an opening is refused for the runtime',
  $q$UPDATE "BillingSeriesOpening" SET "openingNumber"=1$q$, 'permission denied');

RESET ROLE;
-- business 2 gets its declaration from the owner (fixture), then its runtime tries to open an ALREADY USED series
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('fixture: business 2 declaration (owner)',
  pg_temp.decl(910002,1,'EXISTING_CONFIRMATION','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000026',NULL,'רחוב 1',920002), 'OK');
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('O7 an opening for a series that was already used (counter exists) is refused',
  pg_temp.opening(910002,'RECEIPT',1,'NEW_BUSINESS',NULL,NULL,920002), 'SERIES_ALREADY_USED_OPENING_REFUSED');
SELECT pg_temp.expect('R1 business 2 sees none of business 1''s declarations',
  $q$SELECT 1 / (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END) FROM "BusinessIssuerDeclaration" WHERE "businessId"=910001$q$, 'OK');
SELECT pg_temp.expect('R2 business 2 sees none of business 1''s openings',
  $q$SELECT 1 / (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END) FROM "BillingSeriesOpening" WHERE "businessId"=910001$q$, 'OK');
RESET ROLE;
SELECT pg_temp.expect('T1 TRUNCATE is refused even for the owner',
  $q$TRUNCATE "BusinessIssuerDeclaration" CASCADE$q$, 'ISSUER_RECORDS_APPEND_ONLY');
SELECT pg_temp.expect('T2 DELETE is refused even for the owner',
  $q$DELETE FROM "BillingSeriesOpening" WHERE "businessId"=910001$q$, 'ISSUER_RECORDS_APPEND_ONLY');
SELECT pg_temp.expect('T3 the owner (erase path) may UPDATE — the only admitted change',
  $q$UPDATE "BusinessIssuerDeclaration" SET "phone"='erased' WHERE "businessId"=910002$q$, 'OK');
