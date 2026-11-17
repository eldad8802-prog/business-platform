-- 20261220090000_issuer_declaration_forward_correction — DRAFT, owner approval required before merge or apply.
--
-- Owner decision 2026-11-17 (approved in principle): an identity correction FORWARD, by admin approval, after documents
-- were already issued — every historical document unchanged, the whole history kept. Until now the chain guard of
-- 20261126100000 refused ANY CORRECTION once a governed document had been issued under the current declaration
-- (ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED), so a declared business that had issued could not even fix a typo.
--
-- This migration replaces ONE function, public.issuer_declaration_chain_guard(), with the applied text unchanged except
-- the correction block (see the comment inside it):
--   technical fix  — same legal person, same track: legal name, the identifier's digits, the VAT number and contact
--                    details may change; track, legal form, VAT status and identifier type may not. Allowed after
--                    issuance, forward only (effectiveFrom not before the last issued document).
--   legal change   — a different track / legal form / VAT status / identifier type: still refused after issuance
--                    (a change of VAT status is a STATUS_CHANGE; another legal person is another business).
--   before issuance — unchanged: a CORRECTION is allowed exactly as before.
--
-- Not changed: no table, column, constraint, grant, policy or trigger; no document, number, VAT or snapshot; the
-- trigger "BusinessIssuerDeclaration_chain" keeps calling the same function name. Who may file a CORRECTION is
-- unchanged (only the current authorized user — the legal-identity session's controlled correction path writes it,
-- together with the profile update, in its own follow-up migration, owner-approved separately).
--
-- Codes: DZD31 ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED (narrowed), DZD31 ISSUER_CORRECTION_MUST_BE_FORWARD (new).

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.issuer_declaration_chain_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  cur public."BusinessIssuerDeclaration";
  users_in_business integer;
  issued_under boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer_declaration:' || NEW."businessId", 0));
  -- S1 (owner 2026-11-12): FOR UPDATE on the business row conflicts with the FOR KEY SHARE lock that inserting a
  -- "User" (or moving one in) takes on its business — so the count below cannot be changed by a concurrent signup /
  -- invitation until this transaction ends; a user added just before waits here and is counted. Held only for the
  -- declaration transaction (milliseconds).
  PERFORM 1 FROM public."Business" b WHERE b."id" = NEW."businessId" FOR UPDATE;
  SELECT count(*) INTO users_in_business FROM public."User" u WHERE u."businessId" = NEW."businessId";

  -- AUTHORITY (no order-of-signup anywhere)
  IF NEW."authorityBasis" = 'SOLE_USER_VERIFIED' THEN
    IF users_in_business <> 1 OR NEW."declaredByUserId" <> NEW."authorizedUserId"
       OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = NEW."authorizedUserId" AND u."businessId" = NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_AUTHORITY_SOLE_USER_REQUIRED';
    END IF;
  ELSIF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER' THEN
    NULL;  -- checked against the current declaration below
  ELSIF NEW."authorityBasis" = 'PLATFORM_DESIGNATED' THEN
    NULL;  -- the writer is checked by BusinessIssuerDeclaration_designation_origin (SECURITY INVOKER)
  END IF;

  -- R1 (review 2026-11-11): a declaration cannot take effect in the future — a far-future effectiveFrom would make
  -- "documents issued under it" (issuedAt >= effectiveFrom) always empty and so open CORRECTION and erase.
  IF NEW."effectiveFrom" > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_EFFECTIVE_FROM_IN_FUTURE';
  END IF;
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration"
   WHERE "businessId" = NEW."businessId" ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NOT NULL AND NEW."effectiveFrom" < cur."effectiveFrom" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_EFFECTIVE_FROM_BEFORE_CURRENT';
  END IF;
  IF cur."id" IS NULL THEN
    IF NEW."version" <> 1 THEN RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_FIRST_MUST_BE_VERSION_1'; END IF;
    IF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_NO_CURRENT_AUTHORIZED_USER';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER'
     AND (NEW."declaredByUserId" <> cur."authorizedUserId" OR NEW."authorizedUserId" <> cur."authorizedUserId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE';
  END IF;
  IF NEW."supersedesId" IS DISTINCT FROM cur."id" OR NEW."version" <> cur."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_MUST_SUPERSEDE_CURRENT';
  END IF;
  -- after the first: only the CURRENT authorized user may file, unless this is a platform designation
  IF NEW."kind" <> 'AUTHORITY_TRANSFER' AND NEW."declaredByUserId" <> cur."authorizedUserId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE';
  END IF;
  IF NEW."kind" = 'AUTHORITY_TRANSFER' AND NEW."authorityBasis" <> 'PLATFORM_DESIGNATED'
     AND NOT (users_in_business = 1 AND NEW."authorityBasis" = 'SOLE_USER_VERIFIED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_TRANSFER_REQUIRES_DESIGNATION';
  END IF;
  -- the legal person never changes inside a business (a company is a new business)
  IF (NEW."legalForm" <> cur."legalForm" OR NEW."idType" <> cur."idType" OR NEW."idNumber" <> cur."idNumber")
     AND NEW."kind" <> 'CORRECTION' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_IDENTITY_IS_LOCKED';
  END IF;
  -- an AUTHORITY_TRANSFER changes WHO may act, nothing about the issuer
  IF NEW."kind" = 'AUTHORITY_TRANSFER' AND (to_jsonb(NEW) - ARRAY['id','version','supersedesId','kind','authorizedUserId','authorityBasis','authorityEvidenceRef','declaredByUserId','declarantName','declarantCapacity','statementVersion','statementSha256','reauthMethod','reauthAt','effectiveFrom','reason','createdAt'])
                                             <> (to_jsonb(cur) - ARRAY['id','version','supersedesId','kind','authorizedUserId','authorityBasis','authorityEvidenceRef','declaredByUserId','declarantName','declarantCapacity','statementVersion','statementSha256','reauthMethod','reauthAt','effectiveFrom','reason','createdAt']) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_TRANSFER_TOUCHES_IDENTITY';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public."BillingDocument" d
                  WHERE d."businessId" = NEW."businessId" AND d."status"::text = 'ISSUED'
                    AND d."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')
                    AND d."issuedAt" >= cur."effectiveFrom") INTO issued_under;
  -- Forward technical correction (owner decision 2026-11-17, 20261220090000): after documents were issued under the
  -- current declaration, a CORRECTION is allowed ONLY as a technical fix of the same legal person in the same track —
  -- track, legal form, VAT status and identifier type unchanged (legal name, the number's digits, VAT number and contact
  -- details may be corrected) — and ONLY forward: it takes effect after the last document already issued, so every
  -- issued document keeps the issuer it was issued under (each also carries its own frozen issuer snapshot). A change
  -- of legal status (e.g. exempt <-> authorized) after issuance stays refused here; it is a STATUS_CHANGE, not a fix.
  IF NEW."kind" = 'CORRECTION' AND issued_under THEN
    IF NEW."track" <> cur."track" OR NEW."legalForm" <> cur."legalForm"
       OR NEW."vatStatus" <> cur."vatStatus" OR NEW."idType" <> cur."idType" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED';
    END IF;
    IF NEW."effectiveFrom" < (SELECT max(d."issuedAt") FROM public."BillingDocument" d
                               WHERE d."businessId" = NEW."businessId" AND d."status"::text = 'ISSUED'
                                 AND d."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CORRECTION_MUST_BE_FORWARD';
    END IF;
  END IF;
  IF NEW."kind" = 'CONTACT_UPDATE' AND (NEW."track" <> cur."track" OR NEW."legalName" <> cur."legalName"
       OR NEW."vatRegistrationNumber" IS DISTINCT FROM cur."vatRegistrationNumber") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY';
  END IF;
  IF NEW."kind" = 'STATUS_CHANGE' AND (NEW."vatStatus" = cur."vatStatus" OR NEW."effectiveFrom" < cur."effectiveFrom") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_STATUS_CHANGE_INVALID';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.issuer_declaration_chain_guard() FROM PUBLIC;
