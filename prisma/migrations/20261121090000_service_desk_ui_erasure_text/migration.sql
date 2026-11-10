-- ============================================================================================================
-- 20261121090000_service_desk_ui_erasure_text — Service Desk 1.3-0: account erasure also removes the business's
-- Service Desk settings and anonymizes the free texts of its warranty offers.
--
-- Owner direction 2026-11-09 (option A): ServiceSettings is deleted with the account; ServiceWarrantyOffer.scopeText /
-- exclusionsText are replaced by a fixed placeholder; ServiceTextVersion.body is NOT changed.
--
-- WHAT CHANGES: three functions of 20261120090000_service_desk_ui_foundation are replaced (CREATE OR REPLACE, same
-- signatures, same owner, same SECURITY DEFINER / search_path, same grants — re-stated below):
--   * service_desk_ui_erase_business(): also DELETEs the business's ServiceSettings row, and sets scopeText = '[נמחק]',
--     exclusionsText = NULL on every warranty offer of the business (also rows a previous version already erased);
--   * service_settings_guard(): a DELETE is allowed ONLY on the erasure path (service_ui_in_erasure: the transaction-local
--     marker set by the erase function AND current_user = the table owner) — never to the runtime;
--   * service_warranty_offer_guard(): the erasure branch also admits exactly that text replacement; any other change to a
--     locked/presented offer is refused as before.
-- No table, column, constraint, policy, grant or data changes. The erase function runs only for a business being deleted.
--
-- KEPT after the account is deleted (offer): state, durationValue/Unit, startsOn/endsOn, quoteVersion, seq, caseId,
-- statutoryNoticeVersionId, customerAdverse/reaffirm method+time, presentedAt/lockedAt, contentSha256.
-- Rollback: re-apply the three function texts of 20261120090000 (no data to restore: the scrub is one-way by design).
-- ============================================================================================================

CREATE OR REPLACE FUNCTION public.service_desk_ui_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_UI_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_UI_ERASURE_NOT_DELETING: the business is being deleted only after quarantine; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_ui_erasure', 'on', true);

  UPDATE public."ServiceTextVersion" SET "createdByUserId" = NULL, "legallyApprovedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceIntakeTermsSnapshot" SET "presentedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  -- The free texts too (20261121090000). Rows a previous version already erased (texts kept) are completed as well.
  UPDATE public."ServiceWarrantyOffer"
     SET "changeReason" = NULL, "presentedByUserId" = NULL, "createdByUserId" = NULL,
         "scopeText" = '[נמחק]', "exclusionsText" = NULL, "erasedAt" = COALESCE("erasedAt", CURRENT_TIMESTAMP)
   WHERE "businessId" = v_business
     AND ("erasedAt" IS NULL OR "scopeText" <> '[נמחק]' OR "exclusionsText" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceIntakePhoto" SET "createdByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceShareEvent" SET "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServicePhoneReminder" SET "actorUserId" = NULL, "note" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  -- The business's Service Desk settings (warranty template texts, default staff member) go with the account (20261121090000).
  DELETE FROM public."ServiceSettings" WHERE "businessId" = v_business;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  PERFORM set_config('dubiz.service_ui_erasure', 'off', true);

  PERFORM set_config('dubiz.service_storage_erasure', 'on', true);
  INSERT INTO public."ServiceStorageErasure" ("businessId") VALUES (v_business) ON CONFLICT ("businessId") DO NOTHING;
  PERFORM set_config('dubiz.service_storage_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_desk_ui_erase_business() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    -- Account erasure only: service_desk_ui_erase_business() (marker + table owner) deletes the business's settings row.
    IF public.service_ui_in_erasure(TG_RELID) THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_NO_DELETE: settings are never deleted';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."version" <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_VERSION: settings are born at version 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."businessId" <> OLD."businessId" OR NEW."version" <> OLD."version" + 1) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_VERSION: each change moves version by one (optimistic concurrency)';
  END IF;
  IF NEW."activeTermsVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."activeTermsVersionId" AND t."kind" = 'TERMS') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_TEXT_KIND: the active terms must be a TERMS version of this business';
  END IF;
  IF NEW."activeStatutoryNoticeVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."activeStatutoryNoticeVersionId" AND t."kind" = 'STATUTORY_NOTICE') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_TEXT_KIND: the active statutory notice must be a STATUTORY_NOTICE version of this business';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_settings_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_warranty_offer_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_prev public."ServiceWarrantyOffer"%ROWTYPE;
  v_prev_stage text;
  v_max integer;
  v_delivered timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NO_DELETE: a warranty offer is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Account erasure only (marker + table owner): the user references and reason are nulled, and the two free texts are
    -- replaced by the fixed placeholder (exclusions NULL). Duration, dates, state, quote version, statutory notice and
    -- contentSha256 stay — the record that a warranty of that length was given, without its wording.
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['changeReason', 'presentedByUserId', 'createdByUserId', 'scopeText', 'exclusionsText', 'erasedAt', 'updatedAt'])
         = (to_jsonb(OLD) - ARRAY['changeReason', 'presentedByUserId', 'createdByUserId', 'scopeText', 'exclusionsText', 'erasedAt', 'updatedAt'])
       AND NEW."changeReason" IS NULL AND NEW."presentedByUserId" IS NULL AND NEW."createdByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL
       AND NEW."scopeText" = '[נמחק]' AND NEW."exclusionsText" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - ARRAY['presentedByUserId', 'createdByUserId']) = (to_jsonb(OLD) - ARRAY['presentedByUserId', 'createdByUserId'])
       AND (NEW."presentedByUserId" IS NULL OR NEW."presentedByUserId" = OLD."presentedByUserId")
       AND (NEW."createdByUserId" IS NULL OR NEW."createdByUserId" = OLD."createdByUserId") THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  -- every warranty change serialises on the case row (1.2b / M2 convention)
  PERFORM 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CASE: the offer must name a case of the same business';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."erasedAt" IS NOT NULL OR NEW."lockedAt" IS NOT NULL AND NEW."supersedesOfferId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_INSERT: a new offer is DRAFT or PRESENTED (LOCKED only as an extension)';
    END IF;
    SELECT COALESCE(max("seq"), 0) INTO v_max FROM public."ServiceWarrantyOffer" WHERE "businessId" = NEW."businessId" AND "caseId" = NEW."caseId";
    IF NEW."seq" <> v_max + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = format('SERVICE_WARRANTY_SEQ: expected seq %s', v_max + 1);
    END IF;
    IF NEW."state" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_INSERT: a new offer is not SUPERSEDED';
    END IF;
    IF NEW."supersedesOfferId" IS NOT NULL THEN
      -- The predecessor may already be SUPERSEDED in this transaction (the one-live-offer index makes a LOCKED
      -- extension supersede first, then insert); its stage before that is read from lockedAt / presentedAt.
      SELECT * INTO v_prev FROM public."ServiceWarrantyOffer" WHERE "businessId" = NEW."businessId" AND "id" = NEW."supersedesOfferId";
      v_prev_stage := CASE WHEN v_prev."lockedAt" IS NOT NULL THEN 'LOCKED' WHEN v_prev."presentedAt" IS NOT NULL THEN 'PRESENTED' ELSE 'DRAFT' END;
      IF v_prev."caseId" IS DISTINCT FROM NEW."caseId" OR v_prev_stage = 'DRAFT' OR v_prev."erasedAt" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_SUPERSEDE: only a PRESENTED or LOCKED offer of the same case is superseded (a draft is edited or discarded)';
      END IF;
      IF NEW."changeReason" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_REASON_REQUIRED: a change after presentation needs a reason';
      END IF;
      IF v_prev_stage = 'PRESENTED' THEN
        IF NEW."state" NOT IN ('DRAFT', 'PRESENTED') THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_SUPERSEDE: a presented offer is replaced by a DRAFT or PRESENTED offer';
        END IF;
        IF NEW."durationUnit" = v_prev."durationUnit" AND NEW."durationValue" < v_prev."durationValue" AND NOT NEW."customerAdverse" THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_ADVERSE_UNMARKED: a shorter warranty than the one presented is customer-adverse';
        END IF;
      ELSE  -- LOCKED: extension only
        IF NEW."state" <> 'LOCKED' OR NEW."startsOn" IS DISTINCT FROM v_prev."startsOn" OR NEW."endsOn" IS NULL OR NEW."endsOn" <= v_prev."endsOn"
           OR NEW."scopeText" IS DISTINCT FROM v_prev."scopeText" OR NEW."exclusionsText" IS DISTINCT FROM v_prev."exclusionsText"
           OR NEW."customerAdverse" THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_AFTER_HANDOVER: after handover only an extension (same scope and start, later end) is allowed';
        END IF;
        IF NEW."endsOn" <> public.service_warranty_end(NEW."startsOn", NEW."durationValue", NEW."durationUnit") OR NEW."presentedAt" IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_DATES: the end date must be exactly one duration after the start';
        END IF;
      END IF;
    ELSIF NEW."changeReason" IS NOT NULL OR NEW."customerAdverse" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_FIRST: a first offer has no change reason and is not adverse';
    END IF;
  ELSE
    -- UPDATE
    IF NEW."businessId" <> OLD."businessId" OR NEW."caseId" <> OLD."caseId" OR NEW."seq" <> OLD."seq" OR NEW."createdAt" <> OLD."createdAt"
       OR NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_IDENTITY: the offer identity never changes';
    END IF;
    IF OLD."state" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_FINAL: a superseded offer never changes';
    END IF;
    IF OLD."state" <> 'DRAFT' AND (to_jsonb(NEW) -> 'source', to_jsonb(NEW) -> 'quoteVersion', to_jsonb(NEW) -> 'durationValue', to_jsonb(NEW) -> 'durationUnit',
          to_jsonb(NEW) -> 'scopeText', to_jsonb(NEW) -> 'exclusionsText', to_jsonb(NEW) -> 'statutoryNoticeVersionId', to_jsonb(NEW) -> 'contentSha256',
          to_jsonb(NEW) -> 'supersedesOfferId', to_jsonb(NEW) -> 'changeReason', to_jsonb(NEW) -> 'customerAdverse',
          to_jsonb(NEW) -> 'customerReaffirmedAt', to_jsonb(NEW) -> 'customerReaffirmMethod', to_jsonb(NEW) -> 'presentedAt', to_jsonb(NEW) -> 'presentedByUserId')
       IS DISTINCT FROM (to_jsonb(OLD) -> 'source', to_jsonb(OLD) -> 'quoteVersion', to_jsonb(OLD) -> 'durationValue', to_jsonb(OLD) -> 'durationUnit',
          to_jsonb(OLD) -> 'scopeText', to_jsonb(OLD) -> 'exclusionsText', to_jsonb(OLD) -> 'statutoryNoticeVersionId', to_jsonb(OLD) -> 'contentSha256',
          to_jsonb(OLD) -> 'supersedesOfferId', to_jsonb(OLD) -> 'changeReason', to_jsonb(OLD) -> 'customerAdverse',
          to_jsonb(OLD) -> 'customerReaffirmedAt', to_jsonb(OLD) -> 'customerReaffirmMethod', to_jsonb(OLD) -> 'presentedAt', to_jsonb(OLD) -> 'presentedByUserId') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CONTENT_FIXED: the content of a presented offer never changes; write a new offer with a reason';
    END IF;
    IF OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'PRESENTED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a draft is presented or discarded';
    END IF;
    IF OLD."state" = 'PRESENTED' AND NEW."state" NOT IN ('PRESENTED', 'LOCKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a presented offer is locked at handover or superseded';
    END IF;
    IF OLD."state" = 'LOCKED' AND NEW."state" NOT IN ('LOCKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a locked offer is only superseded by an extension';
    END IF;
    IF OLD."state" IN ('LOCKED') AND (NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt" OR NEW."startsOn" IS DISTINCT FROM OLD."startsOn" OR NEW."endsOn" IS DISTINCT FROM OLD."endsOn") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CONTENT_FIXED: a locked offer''s dates never change';
    END IF;
    IF NEW."state" = 'LOCKED' AND OLD."state" = 'PRESENTED' THEN
      SELECT h."deliveredAt" INTO v_delivered FROM public."ServiceHandover" h WHERE h."businessId" = NEW."businessId" AND h."caseId" = NEW."caseId";
      IF v_delivered IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_LOCK_NO_HANDOVER: an offer locks only at handover';
      END IF;
      IF NEW."startsOn" <> v_delivered::date OR NEW."endsOn" <> public.service_warranty_end(NEW."startsOn", NEW."durationValue", NEW."durationUnit") THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_DATES: starts on the delivery day and ends exactly one duration later';
      END IF;
    END IF;
  END IF;

  -- presenting (insert as PRESENTED or DRAFT → PRESENTED): approved statutory notice; who and when; adverse ⇒ reaffirmed
  IF NEW."state" = 'PRESENTED' AND (TG_OP = 'INSERT' OR OLD."state" = 'DRAFT') THEN
    IF NEW."presentedAt" IS NULL OR NEW."presentedByUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_PRESENT: presenting records time and who';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."statutoryNoticeVersionId"
                     AND t."kind" = 'STATUTORY_NOTICE' AND t."legalStatus" = 'LEGALLY_APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NOTICE_NOT_APPROVED: an offer is presented only with a legally approved statutory notice';
    END IF;
    IF NEW."customerAdverse" AND NEW."customerReaffirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_REAFFIRM_REQUIRED: a customer-adverse change needs the customer''s renewed agreement before it is presented';
    END IF;
  END IF;
  IF NEW."state" = 'DRAFT' AND (NEW."statutoryNoticeVersionId" IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."statutoryNoticeVersionId" AND t."kind" = 'STATUTORY_NOTICE') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NOTICE_KIND: the notice must be a STATUTORY_NOTICE version';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_warranty_offer_guard() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.service_desk_ui_erase_business() TO app_runtime;
