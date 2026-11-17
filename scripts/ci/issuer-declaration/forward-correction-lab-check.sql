-- ============================================================================
-- LAB CHECK for prisma/migrations/20261220090000_issuer_declaration_forward_correction — synthetic, throwaway DB
-- where 20261126100000_issuer_declaration and then this migration were applied.
-- Fixtures by the OWNER; declarations filed as decl_lab_rt (NOSUPERUSER NOBYPASSRLS, member of app_runtime), exactly
-- like scripts/ci/issuer-declaration/migration-lab-check.sql. Each check prints PASS/FAIL; a FAIL is a defect.
--   psql <owner url> -v ON_ERROR_STOP=1 -f this-file
-- ============================================================================
\set QUIET on
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'decl_lab_rt') THEN
  CREATE ROLE decl_lab_rt LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE app_runtime; END IF; END $$;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON "BillingDocument", "BillingDocumentNumberSequence" TO app_runtime;
GRANT SELECT, UPDATE ON "BusinessProfile" TO app_runtime;

-- F business: one user, an authorized dealer (individual)
INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES (940001,'fwd-lab-1',now(),now()), (940002,'fwd-lab-2',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES
  (950001,'f1@example.test','x',940001,'USER',now(),now()),
  (950002,'f2@example.test','x',940002,'USER',now(),now());
INSERT INTO "BusinessProfile"("businessId","billingLegalName","billingBusinessKind","billingTaxId","billingVatNumber","createdAt","updatedAt")
  VALUES (940001,'ישראל ישראלי','AUTHORIZED_DEALER','000000018','000000018',now(),now()),
         (940002,'פלונית אלמונית','AUTHORIZED_DEALER','000000026','000000026',now(),now());

-- a declaration row with an explicit effectiveFrom (the original helper always used now())
CREATE OR REPLACE FUNCTION pg_temp.decl(b int, v int, kind text, track text, form text, vat text, lname text,
                                        idtype text, idnum text, vatnum text, eff text, u int)
RETURNS text LANGUAGE sql AS $f$
  SELECT format(
    'INSERT INTO "BusinessIssuerDeclaration"("businessId","version","supersedesId","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt") '
    'SELECT %s,%s,%s,%L,%L,%L,%L,%L,%L,%L,%s,''רחוב 1'',''0500000000'',''lab@example.test'',%s,%s,%L,%s,''בעל העסק לבדיקה'',''בעל העסק'',''issuer-declaration-he-v1'',repeat(''a'',64),''EMAIL_LINK'',now()',
    b, v,
    CASE WHEN v = 1 THEN 'NULL' ELSE format('(SELECT "id" FROM "BusinessIssuerDeclaration" WHERE "businessId"=%s AND "version"=%s)', b, v - 1) END,
    kind, track, form, vat, lname, idtype, idnum,
    CASE WHEN vatnum IS NULL THEN 'NULL' ELSE quote_literal(vatnum) END,
    eff, u, CASE WHEN v = 1 THEN 'SOLE_USER_VERIFIED' ELSE 'CURRENT_AUTHORIZED_USER' END, u)
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

-- ======================= business 940001 ======================================
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '940001', false);
SELECT pg_temp.expect('F0 the first declaration (3 hours ago)',
  pg_temp.decl(940001,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','now() - interval ''3 hours''',950001), 'OK');
SELECT pg_temp.expect('F1 before any issuance a CORRECTION is allowed exactly as before',
  pg_temp.decl(940001,2,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי (תיקון)','ISRAELI_ID','000000018','000000018','now() - interval ''150 minutes''',950001), 'OK');

-- a governed document is issued under version 2 (one hour ago)
RESET ROLE;
INSERT INTO "BillingDocument"("id","businessId","documentType","status","customerNameSnapshot","currency","subtotalAmount","vatAmount","totalAmount","createdAt","updatedAt")
  VALUES (960001,940001,'TAX_INVOICE','DRAFT','x','ILS',100,18,118,now(),now());
UPDATE "BillingDocument" SET "status"='ISSUED', "issuedAt"= now() - interval '1 hour' WHERE "id"=960001;
CREATE TEMP TABLE doc_before AS SELECT * FROM "BillingDocument" WHERE "id"=960001;
GRANT SELECT ON doc_before TO app_runtime;
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '940001', false);

SELECT pg_temp.expect('F2 after issuance a TECHNICAL correction (legal name typo, same track), forward, is allowed',
  pg_temp.decl(940001,3,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','now()',950001), 'OK');
RESET ROLE;
INSERT INTO "BillingDocument"("id","businessId","documentType","status","customerNameSnapshot","currency","subtotalAmount","vatAmount","totalAmount","createdAt","updatedAt")
  VALUES (960002,940001,'RECEIPT','DRAFT','x','ILS',0,0,50,now(),now());
UPDATE "BillingDocument" SET "status"='ISSUED', "issuedAt"= clock_timestamp() WHERE "id"=960002;
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '940001', false);
SELECT pg_temp.expect('F3 after issuance a TECHNICAL correction of the number''s digits / VAT number, same track, forward, is allowed',
  pg_temp.decl(940001,4,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000026','000000026','now()',950001), 'OK');

-- issue another document under version 4, then try the refused shapes
RESET ROLE;
INSERT INTO "BillingDocument"("id","businessId","documentType","status","customerNameSnapshot","currency","subtotalAmount","vatAmount","totalAmount","createdAt","updatedAt")
  VALUES (960003,940001,'TAX_INVOICE','DRAFT','x','ILS',100,18,118,now(),now());
UPDATE "BillingDocument" SET "status"='ISSUED', "issuedAt"= clock_timestamp() WHERE "id"=960003;
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '940001', false);
SELECT pg_temp.expect('F4 after issuance a LEGAL change (authorized → exempt: track / VAT status) is still refused',
  pg_temp.decl(940001,5,'CORRECTION','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','ישראל ישראלי','ISRAELI_ID','000000026',NULL,'now()',950001), 'ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED');
SELECT pg_temp.expect('F5 after issuance a change of identifier type / legal form (individual → company) is still refused',
  pg_temp.decl(940001,5,'CORRECTION','COMPANY_AUTHORIZED_DEALER','COMPANY','AUTHORIZED','ישראל ישראלי בע״מ','COMPANY_NUMBER','510000003','510000003','now()',950001), 'ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED');
SELECT pg_temp.expect('F6 a technical correction BACKDATED before the last issued document is refused (forward only)',
  pg_temp.decl(940001,5,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000026','000000026','(SELECT "effectiveFrom" FROM "BusinessIssuerDeclaration" WHERE "businessId"=940001 AND "version"=4)',950001), 'ISSUER_CORRECTION_MUST_BE_FORWARD');
SELECT pg_temp.expect('F7 CONTACT_UPDATE still may not touch the legal name (unchanged rule)',
  pg_temp.decl(940001,5,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','שם אחר','ISRAELI_ID','000000026','000000026','now()',950001), 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY');
SELECT pg_temp.expect('F8 the issued document is unchanged by the corrections (status, number, issue time, amounts)',
  $q$SELECT 1 / (CASE WHEN (SELECT count(*) FROM "BillingDocument" d JOIN doc_before b USING ("id")
     WHERE d."status" = b."status" AND d."documentNumber" IS NOT DISTINCT FROM b."documentNumber" AND d."issuedAt" = b."issuedAt"
       AND d."totalAmount" = b."totalAmount" AND d."vatAmount" = b."vatAmount" AND d."updatedAt" = b."updatedAt") = 1 THEN 1 ELSE 0 END)$q$, 'OK');
SELECT pg_temp.expect('F9 the profile identity lock follows the CURRENT declaration: the corrected number is accepted',
  $q$UPDATE "BusinessProfile" SET "billingTaxId"='000000026', "billingVatNumber"='000000026' WHERE "businessId"=940001$q$, 'OK');
SELECT pg_temp.expect('F10 …and the superseded (pre-correction) number is refused',
  $q$UPDATE "BusinessProfile" SET "billingTaxId"='000000018' WHERE "businessId"=940001$q$, 'ISSUER_PROFILE_IDENTITY_LOCKED');
SELECT pg_temp.expect('F11 the chain stays complete and ordered: versions 1..4, each superseding the previous',
  $q$SELECT 1 / (CASE WHEN (SELECT count(*) FROM "BusinessIssuerDeclaration" d WHERE d."businessId"=940001
     AND (d."version" = 1 OR d."supersedesId" = (SELECT p."id" FROM "BusinessIssuerDeclaration" p WHERE p."businessId"=940001 AND p."version" = d."version" - 1))) = 4 THEN 1 ELSE 0 END)$q$, 'OK');

-- ======================= business 940002 — no issuance at all =================
SELECT set_config('app.current_business_id', '940002', false);
SELECT pg_temp.expect('G1 a declaration with no issued documents (now)',
  pg_temp.decl(940002,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','פלונית אלמונית','ISRAELI_ID','000000026','000000026','now()',950002), 'OK');
SELECT pg_temp.expect('G2 without issuance even a track change by CORRECTION behaves as before (allowed)',
  pg_temp.decl(940002,2,'CORRECTION','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלונית אלמונית','ISRAELI_ID','000000026',NULL,'now()',950002), 'OK');
RESET ROLE;

-- the function body differs from the applied one ONLY in the correction block (the rest is byte-identical)
SELECT pg_temp.expect('H1 the chain guard is still the trigger function of BusinessIssuerDeclaration_chain',
  $q$SELECT 1 / (SELECT count(*)::int FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgname = 'BusinessIssuerDeclaration_chain' AND p.proname = 'issuer_declaration_chain_guard')$q$, 'OK');
SELECT pg_temp.expect('H2 PUBLIC still has no EXECUTE on the chain guard',
  $q$SELECT 1 / (CASE WHEN has_function_privilege('public', 'public.issuer_declaration_chain_guard()', 'EXECUTE') THEN 0 ELSE 1 END)$q$, 'OK');
