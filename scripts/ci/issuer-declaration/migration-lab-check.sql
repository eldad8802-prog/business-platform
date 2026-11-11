-- ============================================================================
-- LAB CHECK for prisma/migrations/20261123090000_issuer_declaration — synthetic, throwaway DB.
-- Derived from the revision-2 draft check (40 checks) + E0/E6 (erase only while deleting) + N1–N5 (designation origin).
-- Fixtures by the OWNER; checks as decl_lab_rt (NOSUPERUSER NOBYPASSRLS, member of app_runtime).
-- Each check prints PASS/FAIL; a FAIL is a design defect.
--   psql <owner url of a throwaway DB where the draft was applied> -v ON_ERROR_STOP=1 -f this-file
-- ============================================================================
\set QUIET on
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'decl_lab_rt') THEN
  CREATE ROLE decl_lab_rt LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE app_runtime; END IF; END $$;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON "BillingDocument", "BillingDocumentNumberSequence" TO app_runtime;
GRANT SELECT, UPDATE ON "BusinessProfile" TO app_runtime;
GRANT UPDATE ("status","issuedAt") ON "BillingDocument" TO app_runtime;

-- B1 solo (1 user) · B2 solo, used RECEIPT series · B3 two users (designation needed)
INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES (910001,'decl-lab-1',now(),now()),(910002,'decl-lab-2',now(),now()),(910003,'decl-lab-3',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES
  (920001,'d1@example.test','x',910001,'USER',now(),now()),
  (920002,'d2@example.test','x',910002,'USER',now(),now()),
  (920031,'d3a@example.test','x',910003,'USER',now(),now()),
  (920032,'d3b@example.test','x',910003,'USER',now(),now()),
  (929999,'admin@example.test','x',910001,'PLATFORM_ADMIN',now(),now());
DELETE FROM "User" WHERE "id" = 929999;   -- the admin acts through the designation function only
INSERT INTO "BillingDocumentNumberSequence"("businessId","documentType","nextNumber","createdAt","updatedAt") VALUES (910002,'RECEIPT',5,now(),now());
INSERT INTO "BusinessProfile"("businessId","billingLegalName","billingBusinessKind","billingTaxId","billingVatNumber","createdAt","updatedAt")
  VALUES (910001,'ישראל ישראלי','AUTHORIZED_DEALER','000000018','000000018',now(),now());

CREATE OR REPLACE FUNCTION pg_temp.decl(b int, v int, kind text, track text, form text, vat text, lname text,
                                        idtype text, idnum text, vatnum text, addr text, authz int, by_user int, basis text)
RETURNS text LANGUAGE sql AS $f$
  SELECT format(
    'INSERT INTO "BusinessIssuerDeclaration"("businessId","version","supersedesId","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt") '
    'SELECT %s,%s,%s,%L,%L,%L,%L,%L,%L,%L,%s,%L,''0500000000'',''lab@example.test'',now(),%s,%L,%s,''בעל העסק לבדיקה'',''בעל העסק'',''issuer-declaration-he-v1'',repeat(''a'',64),''EMAIL_LINK'',now()',
    b, v,
    CASE WHEN v = 1 THEN 'NULL' ELSE format('(SELECT "id" FROM "BusinessIssuerDeclaration" WHERE "businessId"=%s AND "version"=%s)', b, v - 1) END,
    kind, track, form, vat, lname, idtype, idnum,
    CASE WHEN vatnum IS NULL THEN 'NULL' ELSE quote_literal(vatnum) END,
    addr, authz, basis, by_user)
$f$;

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

-- ======================= business 1 — a single user ==========================
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('A1 sole user of the business confirms (server verifies: exactly one user, and it is the confirmer)',
  pg_temp.decl(910001,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 1',920001,920001,'SOLE_USER_VERIFIED'), 'OK');
SELECT pg_temp.expect('A2 nobody may self-assign the PLATFORM_DESIGNATED basis from the runtime',
  pg_temp.decl(910001,2,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001,920001,'PLATFORM_DESIGNATED'), 'ISSUER_DESIGNATION_ONLY_BY_PLATFORM_FUNCTION');
SELECT pg_temp.expect('D1 a track that does not match its legal form / VAT status is refused',
  pg_temp.decl(910001,2,'CORRECTION','COMPANY_AUTHORIZED_DEALER','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 1',920001,920001,'CURRENT_AUTHORIZED_USER'), 'IssuerDeclaration_track_shape');
SELECT pg_temp.expect('D2 an authorized dealer without a VAT registration number is refused',
  pg_temp.decl(910001,2,'CORRECTION','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018',NULL,'רחוב 2',920001,920001,'CURRENT_AUTHORIZED_USER'), 'IssuerDeclaration_vat_number');
SELECT pg_temp.expect('D3 skipping the chain (version 3 while the current is 1) is refused',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001,920001,'CURRENT_AUTHORIZED_USER'), 'ISSUER_DECLARATION_MUST_SUPERSEDE_CURRENT');
SELECT pg_temp.expect('D4 a contact update (new address) by the authorized user is accepted',
  pg_temp.decl(910001,2,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 2',920001,920001,'CURRENT_AUTHORIZED_USER'), 'OK');
SELECT pg_temp.expect('D5 a contact update that changes the legal name is refused',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','שם אחר','ISRAELI_ID','000000018','000000018','רחוב 2',920001,920001,'CURRENT_AUTHORIZED_USER'), 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY');
SELECT pg_temp.expect('D6 becoming a company (new legal person) inside the business is refused',
  pg_temp.decl(910001,3,'STATUS_CHANGE','COMPANY_AUTHORIZED_DEALER','COMPANY','AUTHORIZED','חברה בע"מ','COMPANY_NUMBER','516000004','516000004','רחוב 2',920001,920001,'CURRENT_AUTHORIZED_USER'), 'ISSUER_IDENTITY_IS_LOCKED');
SELECT pg_temp.expect('D7 UPDATE / DELETE of a declaration are refused for the runtime',
  $q$DELETE FROM "BusinessIssuerDeclaration" WHERE "businessId"=910001$q$, 'permission denied');
SELECT pg_temp.expect('D8 a declaration for ANOTHER business is refused by RLS',
  pg_temp.decl(910002,1,'INITIAL','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000026',NULL,'רחוב 1',920002,920002,'SOLE_USER_VERIFIED'), 'row-level security');

-- profile lock (B2): the profile mirrors the current declaration
SELECT pg_temp.expect('L1 editing the profile legal name away from the declaration is refused (an older release cannot reopen it)',
  $q$UPDATE "BusinessProfile" SET "billingLegalName" = 'שם אחר' WHERE "businessId" = 910001$q$, 'ISSUER_PROFILE_IDENTITY_LOCKED');
SELECT pg_temp.expect('L2 clearing the profile classification is refused',
  $q$UPDATE "BusinessProfile" SET "billingBusinessKind" = NULL WHERE "businessId" = 910001$q$, 'ISSUER_PROFILE_IDENTITY_LOCKED');
SELECT pg_temp.expect('L3 writing the same identity (projection) is accepted',
  $q$UPDATE "BusinessProfile" SET "billingLegalName" = 'ישראל ישראלי' WHERE "businessId" = 910001$q$, 'OK');

-- openings
SELECT pg_temp.expect('O1 continuing a previous tool: opening 459 after last 458 is accepted',
  pg_temp.opening(910001,'TAX_INVOICE',459,'CONTINUES_PREVIOUS_TOOL','ספר ידני',458,920001), 'OK');
SELECT pg_temp.expect('O2 a second opening for the same series is refused',
  pg_temp.opening(910001,'TAX_INVOICE',1,'NEW_BUSINESS',NULL,NULL,920001), 'BillingSeriesOpening_series_key');
SELECT pg_temp.expect('O3 NEW_BUSINESS with an opening other than 1 is refused',
  pg_temp.opening(910001,'RECEIPT',7,'NEW_BUSINESS',NULL,NULL,920001), 'SeriesOpening_source_shape');
SELECT pg_temp.expect('O4 an opening that does not follow the previous tool''s last number is refused',
  pg_temp.opening(910001,'RECEIPT',100,'CONTINUES_PREVIOUS_TOOL','תוכנה קודמת',458,920001), 'SeriesOpening_source_shape');
SELECT pg_temp.expect('O5 UPDATE of an opening is refused for the runtime',
  $q$UPDATE "BillingSeriesOpening" SET "openingNumber"=1$q$, 'permission denied');

-- ======================= business 3 — two users ==============================
SELECT set_config('app.current_business_id', '910003', false);
SELECT pg_temp.expect('A3 a business with TWO users cannot self-confirm (no order-of-signup authority)',
  pg_temp.decl(910003,1,'INITIAL','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלונית','ISRAELI_ID','000000034',NULL,'רחוב 3',920031,920031,'SOLE_USER_VERIFIED'), 'ISSUER_AUTHORITY_SOLE_USER_REQUIRED');

-- business 1 gains a second user; that user may not change anything
RESET ROLE;
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES (920011,'d1b@example.test','x',910001,'USER',now(),now());
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('A4 a second user of the same business may not file a change',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 3',920001,920011,'CURRENT_AUTHORIZED_USER'), 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE');
SELECT pg_temp.expect('A5 with two users, the CURRENT authorized user still files (authority is named, not counted)',
  pg_temp.decl(910001,3,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 3',920001,920001,'CURRENT_AUTHORIZED_USER'), 'OK');
SELECT pg_temp.expect('A5b with two users, nobody can claim SOLE_USER again',
  pg_temp.decl(910001,4,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 4',920001,920001,'SOLE_USER_VERIFIED'), 'ISSUER_AUTHORITY_SOLE_USER_REQUIRED');
SELECT pg_temp.expect('A6 the runtime cannot call the platform designation function',
  $q$SELECT public.issuer_designate_authorized_user(910001, 920011, 920001, 'x', 'case-1', 'x', 'v1', repeat('a',64))$q$, 'permission denied');

-- access recovery: a platform admin (owner here = app_admin in Production) designates the second user
RESET ROLE;
SELECT pg_temp.expect('A7 platform designation (evidence ref + elevation) transfers authority, issuer unchanged',
  $q$SELECT public.issuer_designate_authorized_user(910001, 920011, 920001, 'מנהל לבדיקה', 'support-case-123', 'המאשר אינו זמין', 'designation-he-v1', repeat('b',64))$q$, 'OK');
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('A8 after the transfer the OLD authorized user may not file',
  pg_temp.decl(910001,5,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 5',920001,920001,'CURRENT_AUTHORIZED_USER'), 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE');
SELECT pg_temp.expect('A8b the NEW authorized user may',
  pg_temp.decl(910001,5,'CONTACT_UPDATE','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','ISRAELI_ID','000000018','000000018','רחוב 5',920011,920011,'CURRENT_AUTHORIZED_USER'), 'OK');
SELECT pg_temp.expect('A9 the transfer did not change the issuer identity (same idNumber, legal name, track)',
  $q$SELECT 1/(CASE WHEN count(DISTINCT ("idNumber","legalName","track")) = 1 THEN 1 ELSE 0 END) FROM "BusinessIssuerDeclaration" WHERE "businessId"=910001$q$, 'OK');

-- ======================= business 2 — used series ============================
RESET ROLE;
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('fixture: business 2 declaration (owner)',
  pg_temp.decl(910002,1,'EXISTING_CONFIRMATION','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000026',NULL,'רחוב 1',920002,920002,'SOLE_USER_VERIFIED'), 'OK');
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('O6 an opening for a series that was already used (counter exists) is refused',
  pg_temp.opening(910002,'RECEIPT',1,'NEW_BUSINESS',NULL,NULL,920002), 'SERIES_ALREADY_USED_OPENING_REFUSED');
SELECT pg_temp.expect('R1 business 2 sees none of business 1''s declarations or openings',
  $q$SELECT 1 / (CASE WHEN (SELECT count(*) FROM "BusinessIssuerDeclaration" WHERE "businessId"=910001) + (SELECT count(*) FROM "BillingSeriesOpening" WHERE "businessId"=910001) = 0 THEN 1 ELSE 0 END)$q$, 'OK');

-- ======================= enforcement (one-way) and issuance ====================
RESET ROLE;
INSERT INTO "IssuerDeclarationEnforcement"("enforcedFrom","recordedBy") VALUES (now(), 'lab');
INSERT INTO "BillingDocument"("id","businessId","documentType","status","customerNameSnapshot","currency","subtotalAmount","vatAmount","totalAmount","createdAt","updatedAt")
  VALUES (930001,910003,'RECEIPT','DRAFT','x','ILS',0,0,10,now(),now()), (930002,910002,'RECEIPT','DRAFT','x','ILS',0,0,10,now(),now());
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910003', false);
SELECT pg_temp.expect('B1 with enforcement on, a business with NO declaration cannot move a document to ISSUED (any release)',
  $q$UPDATE "BillingDocument" SET "status"='ISSUED' WHERE "id"=930001$q$, 'ISSUER_DECLARATION_REQUIRED_TO_ISSUE');
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('B2 a business WITH a declaration can',
  $q$UPDATE "BillingDocument" SET "status"='ISSUED', "issuedAt"=now() WHERE "id"=930002$q$, 'OK');
RESET ROLE;
SELECT pg_temp.expect('B3 enforcement cannot be switched off by deleting its row (even the owner)',
  $q$DELETE FROM "IssuerDeclarationEnforcement"$q$, 'ISSUER_RECORDS_APPEND_ONLY');

-- ======================= erase (R-split) ======================================
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('E0 the erase is refused while the business is not being deleted (runtime, live business)',
  $q$SELECT public.issuer_declaration_erase()$q$, 'ISSUER_ERASE_NOT_DELETING');
RESET ROLE;
UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" IN (910002, 910003);
SELECT set_config('app.current_business_id', '910002', false);
SELECT pg_temp.expect('E1 the erase keeps a declaration that a fiscal document was issued under (business 2)',
  $q$SELECT 1/(CASE WHEN public.issuer_declaration_erase() = 0 THEN 1 ELSE 0 END)$q$, 'OK');
SELECT set_config('app.current_business_id', '910003', false);
SELECT public.issuer_designate_initial(910003, 920031, 920032, 'מנהל', 'support-case-9', 'שני משתמשים בעסק', 'v1', repeat('c',64),
  '{"track":"EXEMPT_DEALER","legalForm":"INDIVIDUAL","vatStatus":"EXEMPT","legalName":"פלונית","idType":"ISRAELI_ID","idNumber":"000000034","address":"רחוב 3","phone":"050","email":"b3@example.test"}'::jsonb);
SELECT pg_temp.expect('E2 the erase anonymises a declaration nothing was issued under (business 3)',
  $q$SELECT 1/(CASE WHEN public.issuer_declaration_erase() = 1 THEN 1 ELSE 0 END)$q$, 'OK');
SELECT pg_temp.expect('E3 the anonymised row kept its structure (track, version, dates) and lost the personal fields',
  $q$SELECT 1/(CASE WHEN "legalName"='—' AND "idNumber"='000000000' AND "track"='EXEMPT_DEALER' AND "anonymisedAt" IS NOT NULL THEN 1 ELSE 0 END) FROM "BusinessIssuerDeclaration" WHERE "businessId"=910003$q$, 'OK');
SELECT pg_temp.expect('E4 even the owner may not change anything else (e.g. the track)',
  $q$UPDATE "BusinessIssuerDeclaration" SET "track"='AUTHORIZED_DEALER_INDIVIDUAL' WHERE "businessId"=910002$q$, 'ISSUER_RECORDS_APPEND_ONLY');
SELECT pg_temp.expect('E5 nobody may DELETE a declaration (owner included)',
  $q$DELETE FROM "BusinessIssuerDeclaration" WHERE "businessId"=910003$q$, 'ISSUER_RECORDS_APPEND_ONLY');
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('E6 the runtime cannot erase a live business''s declaration (business 1 is not being deleted)',
  $q$SELECT public.issuer_declaration_erase()$q$, 'ISSUER_ERASE_NOT_DELETING');
RESET ROLE;
SELECT pg_temp.expect('T1 TRUNCATE is refused even for the owner',
  $q$TRUNCATE "BusinessIssuerDeclaration" CASCADE$q$, 'ISSUER_RECORDS_APPEND_ONLY');

-- ======================= designation origin (migration fix 1) =================
-- business 4: two users, no declaration yet
INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES (910004,'decl-lab-4',now(),now()), (910099,'decl-lab-platform',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES (929000,'platform-admin@example.test','x',910099,'PLATFORM_ADMIN',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES
  (920041,'d4a@example.test','x',910004,'USER',now(),now()),
  (920042,'d4b@example.test','x',910004,'USER',now(),now());
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910004', false);
SELECT pg_temp.expect('N1 the runtime cannot forge a designation even after setting app.issuer_designation=on itself',
  $q$INSERT INTO "BusinessIssuerDeclaration"("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","authorityEvidenceRef","declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt")
     SELECT 910004,1,'INITIAL','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000042','רחוב 4','050','b4@example.test',now(),920041,'PLATFORM_DESIGNATED','forged',920042,'x','x','v1',repeat('d',64),'PLATFORM_ADMIN_ELEVATION',now()
     FROM (SELECT set_config('app.issuer_designation','on',true)) s$q$, 'ISSUER_DESIGNATION_ONLY_BY_PLATFORM_FUNCTION');
SELECT pg_temp.expect('N2 the runtime cannot call the initial-designation function',
  $q$SELECT public.issuer_designate_initial(910004, 920041, 920042, 'x', 'case', 'x', 'v1', repeat('d',64), '{}'::jsonb)$q$, 'permission denied');
RESET ROLE;
SELECT pg_temp.expect('N3 a platform admin designates the first authorized user of a two-user business, with evidence',
  $q$SELECT public.issuer_designate_initial(910004, 920041, 929000, 'מנהל לבדיקה', 'support-case-44', 'שני משתמשים', 'designation-he-v1', repeat('d',64),
     '{"track":"EXEMPT_DEALER","legalForm":"INDIVIDUAL","vatStatus":"EXEMPT","legalName":"פלוני","idType":"ISRAELI_ID","idNumber":"000000042","address":"רחוב 4","phone":"050","email":"b4@example.test"}'::jsonb)$q$, 'OK');
SELECT pg_temp.expect('N4 the stored record names the designated user, basis PLATFORM_DESIGNATED and the evidence reference',
  $q$SELECT 1/(CASE WHEN count(*) = 1 THEN 1 ELSE 0 END) FROM "BusinessIssuerDeclaration"
     WHERE "businessId"=910004 AND "authorizedUserId"=920041 AND "authorityBasis"='PLATFORM_DESIGNATED' AND "authorityEvidenceRef"='support-case-44' AND "reauthMethod"='PLATFORM_ADMIN_ELEVATION'$q$, 'OK');
SELECT pg_temp.expect('N5 the initial designation cannot be repeated once a declaration exists',
  $q$SELECT public.issuer_designate_initial(910004, 920042, 929000, 'x', 'case', 'x', 'v1', repeat('d',64), '{"track":"EXEMPT_DEALER","legalForm":"INDIVIDUAL","vatStatus":"EXEMPT","legalName":"x","idType":"ISRAELI_ID","idNumber":"000000042","address":"x","phone":"x","email":"x@x.x"}'::jsonb)$q$, 'ISSUER_DESIGNATION_INITIAL_ALREADY_DECLARED');

-- ======================= account deletion: the profile lock admits the purge ==
-- business 1 has a live declaration; the runtime purge clears the identity columns only once deletion is requested
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('P1 while the business is live, the runtime still cannot clear the locked identity',
  $q$UPDATE "BusinessProfile" SET "billingLegalName" = NULL, "billingTaxId" = NULL, "billingVatNumber" = NULL WHERE "businessId" = 910001$q$, 'ISSUER_PROFILE_IDENTITY_LOCKED');
RESET ROLE;
UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = 910001;
SET ROLE decl_lab_rt;
SELECT set_config('app.current_business_id', '910001', false);
SELECT pg_temp.expect('P2 once deletion is requested (stage 1), the runtime purge clears the identity columns',
  $q$UPDATE "BusinessProfile" SET "billingLegalName" = NULL, "billingTaxId" = NULL, "billingVatNumber" = NULL WHERE "businessId" = 910001$q$, 'OK');
RESET ROLE;
SELECT pg_temp.expect('P3 the declaration itself is untouched by that (legal name and id number kept)',
  $q$SELECT 1/(CASE WHEN count(*) >= 1 THEN 1 ELSE 0 END) FROM "BusinessIssuerDeclaration" WHERE "businessId" = 910001 AND "legalName" = 'ישראל ישראלי' AND "idNumber" = '000000018' AND "anonymisedAt" IS NULL$q$, 'OK');
