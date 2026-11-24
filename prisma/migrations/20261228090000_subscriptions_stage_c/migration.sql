-- ============================================================================================================
-- 20261228090000_subscriptions_stage_c — DRAFT. NOT APPLIED anywhere. Owner approval required to apply.
--
-- Dubiz subscriptions stage C (owner-approved for development 2026-11-24, decisions 1–29): the ONE migration of the
-- stage. Everything here is inert until code reads it, and the code ships with trials OFF and quotas in SHADOW.
--
--   A. Trial lifecycle
--      1. "PlatformTrialClaim"           keyed HMAC digests of the identity a trial was opened for (tax id, login
--                                        email, Google subject, phone as a hint) — duplicate-trial prevention
--                                        (decisions 13 / 28). Digests only: no identity value is stored here.
--      2. "PlatformSubscriptionRequest"  "I'm interested" plan requests and quota-increase requests (decision 14).
--      3. subscription_signup_open()     the auth plane opens the new business's record INSIDE the signup transaction:
--                                        a 30-day trial, or — when a claim matches — no trial (FREE_LIMITED).
--      4. subscription_expire_due_trials()  records TRIALING → FREE_LIMITED for trials that ended (the state is
--                                        already computed from trialEndsAt; this only writes the transition and its log).
--   B. Central usage quotas (decisions 17–29)
--      5b. "PlatformUsageMetricMode"     OFF / SHADOW / ENFORCE per quota metric (admin, no deploy); seeded SHADOW. The
--                                        app takes the lower of this and its own server ceiling (env USAGE_QUOTA_MODE).
--      5. "PlatformQuotaPolicy"          the quota per metric and tier (TRIAL / BASIC / ADVANCED / PREMIUM /
--                                        FREE_LIMITED), seeded with the owner's opening matrix; admin-editable.
--      6. "PlatformQuotaPolicyEvent"     append-only history of every policy change.
--      7. "BusinessQuotaAdjustment"      per-business additions and special quotas (admin today, purchases later).
--      8. "BusinessUsageCounter"         one row per business, metric and period: the used amount.
--      9. "BusinessUsageEvent"           one row per counted unit (unique per business, metric and unit key): the
--                                        idempotency ledger — a retry of the same unit is never counted twice.
--     10. usage_consume() / usage_settle()  the ONLY writers of 8 and 9: atomic (row lock on the counter), period and
--                                        quota resolved inside the database from the subscription record, the policy
--                                        and the adjustments; testers and internal accounts are never refused.
--     11. quota_policy_set(), quota_adjustment_add(), quota_adjustment_revoke(), subscription_request_resolve(),
--         usage_metric_mode_set(), trial_claim_admin_record()
--                                        the admin writers, executable by app_admin only; each checks that the actor is
--                                        a PLATFORM_ADMIN and writes a PlatformAuditEvent in the same statement.
--   C. Admin console read (app_admin, read-only, additive p7adm_read policies) on the stage B tables and every new one.
--
-- Unchanged: every existing table, row, constraint, policy and grant; the 43 testers stay testers (no row is
-- written to PlatformSubscription here). Additive only — .subscriptions-stage-c/rollback.sql restores the previous
-- state exactly.
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."PlatformSubscription"') IS NULL OR to_regclass('public."PlatformSubscriptionEvent"') IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTIONS_STAGE_C: stage B tables are missing; nothing was changed';
  END IF;
  IF to_regclass('public."PlatformAuditEvent"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTIONS_STAGE_C: PlatformAuditEvent or User is missing; nothing was changed';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_runtime', 'app_ctlplane', 'app_auth', 'app_admin')) <> 4 THEN
    RAISE EXCEPTION 'SUBSCRIPTIONS_STAGE_C: one of app_runtime, app_ctlplane, app_auth, app_admin is missing; nothing was changed';
  END IF;
  IF to_regclass('public."PlatformTrialClaim"') IS NOT NULL OR to_regclass('public."PlatformQuotaPolicy"') IS NOT NULL
     OR to_regclass('public."BusinessUsageCounter"') IS NOT NULL OR to_regclass('public."BusinessUsageEvent"') IS NOT NULL
     OR to_regclass('public."PlatformUsageMetricMode"') IS NOT NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTIONS_STAGE_C: a stage C table already exists; nothing was changed';
  END IF;
END
$do$;

-- ── A1. Trial claims ─────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformTrialClaim" (
  "id"         BIGSERIAL    NOT NULL,
  "kind"       TEXT         NOT NULL,
  "digest"     TEXT         NOT NULL,
  "keyVersion" INTEGER      NOT NULL,
  -- SET NULL on business deletion: the claim outlives the business, so a deleted business cannot reopen a trial.
  "businessId" INTEGER,
  "outcome"    TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTrialClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTrialClaim_kind" CHECK ("kind" IN ('TAX_ID', 'EMAIL', 'GOOGLE_SUB', 'PHONE')),
  CONSTRAINT "PlatformTrialClaim_digest" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PlatformTrialClaim_key_version" CHECK ("keyVersion" BETWEEN 1 AND 1000),
  CONSTRAINT "PlatformTrialClaim_outcome" CHECK ("outcome" IN ('TRIAL_OPENED', 'DUPLICATE_DETECTED', 'ADMIN_RECORDED'))
);
CREATE INDEX "PlatformTrialClaim_kind_digest_idx" ON "PlatformTrialClaim"("kind", "digest");
CREATE INDEX "PlatformTrialClaim_businessId_idx" ON "PlatformTrialClaim"("businessId");
ALTER TABLE "PlatformTrialClaim" ADD CONSTRAINT "PlatformTrialClaim_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── A2. Plan and quota requests ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformSubscriptionRequest" (
  "id"              BIGSERIAL    NOT NULL,
  "businessId"      INTEGER      NOT NULL,
  "kind"            TEXT         NOT NULL,
  "requestedPlan"   TEXT,
  "metric"          TEXT,
  "note"            TEXT,
  "status"          TEXT         NOT NULL DEFAULT 'OPEN',
  "createdByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "handledAt"       TIMESTAMP(3),
  "handledByUserId" INTEGER,
  "handledNote"     TEXT,
  CONSTRAINT "PlatformSubscriptionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformSubscriptionRequest_kind" CHECK ("kind" IN ('PLAN', 'QUOTA')),
  CONSTRAINT "PlatformSubscriptionRequest_plan" CHECK ("requestedPlan" IS NULL OR "requestedPlan" IN ('BASIC', 'ADVANCED', 'PREMIUM')),
  CONSTRAINT "PlatformSubscriptionRequest_metric" CHECK ("metric" IS NULL OR "metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "PlatformSubscriptionRequest_shape" CHECK (("kind" = 'PLAN') = ("requestedPlan" IS NOT NULL) AND ("kind" = 'QUOTA') = ("metric" IS NOT NULL)),
  CONSTRAINT "PlatformSubscriptionRequest_note" CHECK ("note" IS NULL OR length("note") <= 500),
  CONSTRAINT "PlatformSubscriptionRequest_status" CHECK ("status" IN ('OPEN', 'HANDLED', 'DISMISSED')),
  CONSTRAINT "PlatformSubscriptionRequest_handled" CHECK (("status" = 'OPEN') = ("handledAt" IS NULL) AND ("status" = 'OPEN') = ("handledByUserId" IS NULL)),
  CONSTRAINT "PlatformSubscriptionRequest_handled_note" CHECK ("handledNote" IS NULL OR length("handledNote") <= 500)
);
-- One open request per business and subject: a repeated click is the same request, not a new one.
CREATE UNIQUE INDEX "PlatformSubscriptionRequest_one_open_key" ON "PlatformSubscriptionRequest"
  ("businessId", "kind", COALESCE("requestedPlan", ''), COALESCE("metric", '')) WHERE "status" = 'OPEN';
CREATE INDEX "PlatformSubscriptionRequest_status_createdAt_idx" ON "PlatformSubscriptionRequest"("status", "createdAt");
ALTER TABLE "PlatformSubscriptionRequest" ADD CONSTRAINT "PlatformSubscriptionRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── B5–B6. Quota policy and its history ──────────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformQuotaPolicy" (
  "metric"          TEXT         NOT NULL,
  "tier"            TEXT         NOT NULL,
  "quota"           BIGINT       NOT NULL,
  "version"         INTEGER      NOT NULL DEFAULT 1,
  "updatedByUserId" INTEGER,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformQuotaPolicy_pkey" PRIMARY KEY ("metric", "tier"),
  CONSTRAINT "PlatformQuotaPolicy_metric" CHECK ("metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "PlatformQuotaPolicy_tier" CHECK ("tier" IN ('TRIAL', 'BASIC', 'ADVANCED', 'PREMIUM', 'FREE_LIMITED')),
  -- A hard ceiling against a typing slip: 1,000,000 units, or 1 TiB for a byte metric.
  CONSTRAINT "PlatformQuotaPolicy_quota" CHECK ("quota" >= 0 AND "quota" <= CASE WHEN "metric" LIKE '%\_bytes' THEN 1099511627776 ELSE 1000000 END),
  CONSTRAINT "PlatformQuotaPolicy_version" CHECK ("version" >= 1)
);

CREATE TABLE "PlatformQuotaPolicyEvent" (
  "id"          BIGSERIAL    NOT NULL,
  "metric"      TEXT         NOT NULL,
  "tier"        TEXT         NOT NULL,
  "fromQuota"   BIGINT,
  "toQuota"     BIGINT       NOT NULL,
  "actorUserId" INTEGER,
  "reason"      TEXT         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformQuotaPolicyEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformQuotaPolicyEvent_reason" CHECK (length(btrim("reason")) BETWEEN 3 AND 500)
);
CREATE INDEX "PlatformQuotaPolicyEvent_metric_tier_createdAt_idx" ON "PlatformQuotaPolicyEvent"("metric", "tier", "createdAt");

-- ── B7. Per-business adjustments ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "BusinessQuotaAdjustment" (
  "id"              BIGSERIAL    NOT NULL,
  "businessId"      INTEGER      NOT NULL,
  "metric"          TEXT         NOT NULL,
  "kind"            TEXT         NOT NULL,
  "amount"          BIGINT       NOT NULL,
  "startsAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt"          TIMESTAMP(3),
  "source"          TEXT         NOT NULL,
  "reason"          TEXT         NOT NULL,
  "createdByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"       TIMESTAMP(3),
  "revokedByUserId" INTEGER,
  "revokeReason"    TEXT,
  CONSTRAINT "BusinessQuotaAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessQuotaAdjustment_metric" CHECK ("metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "BusinessQuotaAdjustment_kind" CHECK ("kind" IN ('ADD', 'OVERRIDE')),
  CONSTRAINT "BusinessQuotaAdjustment_amount" CHECK ("amount" >= 0 AND "amount" <= CASE WHEN "metric" LIKE '%\_bytes' THEN 1099511627776 ELSE 1000000 END),
  CONSTRAINT "BusinessQuotaAdjustment_window" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
  CONSTRAINT "BusinessQuotaAdjustment_source" CHECK ("source" IN ('ADMIN', 'PURCHASE')),
  CONSTRAINT "BusinessQuotaAdjustment_admin_actor" CHECK ("source" <> 'ADMIN' OR "createdByUserId" IS NOT NULL),
  CONSTRAINT "BusinessQuotaAdjustment_reason" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "BusinessQuotaAdjustment_revoke" CHECK (("revokedAt" IS NULL) = ("revokedByUserId" IS NULL) AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)),
  CONSTRAINT "BusinessQuotaAdjustment_revoke_reason" CHECK ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 3 AND 500)
);
CREATE INDEX "BusinessQuotaAdjustment_businessId_metric_idx" ON "BusinessQuotaAdjustment"("businessId", "metric");
ALTER TABLE "BusinessQuotaAdjustment" ADD CONSTRAINT "BusinessQuotaAdjustment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── B5b. Activation mode per quota metric (OFF / SHADOW / ENFORCE), admin-managed without a deploy. The application
--    takes the LOWER of this mode and its own server ceiling (env USAGE_QUOTA_MODE, default shadow): the database alone
--    can never switch enforcement on. Seeded SHADOW for every quota metric (decision 25: measure first). ──

CREATE TABLE "PlatformUsageMetricMode" (
  "metric"          TEXT         NOT NULL,
  "mode"            TEXT         NOT NULL,
  "updatedByUserId" INTEGER,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformUsageMetricMode_pkey" PRIMARY KEY ("metric"),
  CONSTRAINT "PlatformUsageMetricMode_metric" CHECK ("metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "PlatformUsageMetricMode_mode" CHECK ("mode" IN ('OFF', 'SHADOW', 'ENFORCE'))
);
INSERT INTO "PlatformUsageMetricMode" ("metric", "mode") VALUES
  ('business_documents', 'SHADOW'), ('document_uploads', 'SHADOW'), ('ocr_pages', 'SHADOW'), ('storage_customer_bytes', 'SHADOW'),
  ('accountant_packages', 'SHADOW'), ('accountant_emails', 'SHADOW'), ('ai_owner_actions', 'SHADOW'), ('video_renders', 'SHADOW');

-- ── B8–B9. Counters and the unit ledger ──────────────────────────────────────────────────────────────────────

CREATE TABLE "BusinessUsageCounter" (
  "businessId"   INTEGER      NOT NULL,
  "metric"       TEXT         NOT NULL,
  "periodKey"    TEXT         NOT NULL,
  "periodStart"  TIMESTAMP(3),
  "periodEnd"    TIMESTAMP(3),
  "used"         BIGINT       NOT NULL DEFAULT 0,
  "alertedPct"   INTEGER      NOT NULL DEFAULT 0,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessUsageCounter_pkey" PRIMARY KEY ("businessId", "metric", "periodKey"),
  CONSTRAINT "BusinessUsageCounter_metric" CHECK ("metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "BusinessUsageCounter_period_key" CHECK ("periodKey" ~ '^(ALL|m:[0-9]{4}-[0-9]{2}|t:[0-9]{8}T[0-9]{6}|p:[0-9]{8}T[0-9]{6})$'),
  CONSTRAINT "BusinessUsageCounter_period_order" CHECK ("periodStart" IS NULL OR "periodEnd" IS NULL OR "periodEnd" > "periodStart"),
  CONSTRAINT "BusinessUsageCounter_used" CHECK ("used" >= 0),
  CONSTRAINT "BusinessUsageCounter_alerted" CHECK ("alertedPct" IN (0, 80, 90, 100))
);
ALTER TABLE "BusinessUsageCounter" ADD CONSTRAINT "BusinessUsageCounter_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessUsageEvent" (
  "id"         BIGSERIAL    NOT NULL,
  "businessId" INTEGER      NOT NULL,
  "metric"     TEXT         NOT NULL,
  "periodKey"  TEXT         NOT NULL,
  "unitKey"    TEXT         NOT NULL,
  "amount"     BIGINT       NOT NULL,
  "state"      TEXT         NOT NULL,
  "verdict"    TEXT         NOT NULL,
  "source"     TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"  TIMESTAMP(3),
  CONSTRAINT "BusinessUsageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessUsageEvent_metric" CHECK ("metric" ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT "BusinessUsageEvent_unit_key" CHECK (length("unitKey") BETWEEN 1 AND 200),
  CONSTRAINT "BusinessUsageEvent_amount" CHECK ("amount" > 0 AND "amount" <= 1099511627776),
  CONSTRAINT "BusinessUsageEvent_state" CHECK ("state" IN ('COUNTED', 'RESERVED', 'RELEASED', 'UNKNOWN')),
  CONSTRAINT "BusinessUsageEvent_verdict" CHECK ("verdict" IN ('WITHIN', 'OVER_SHADOW', 'UNLIMITED')),
  CONSTRAINT "BusinessUsageEvent_source" CHECK ("source" ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  CONSTRAINT "BusinessUsageEvent_settled" CHECK (("state" = 'RESERVED') = ("settledAt" IS NULL))
);
CREATE UNIQUE INDEX "BusinessUsageEvent_unit_key" ON "BusinessUsageEvent"("businessId", "metric", "unitKey");
CREATE INDEX "BusinessUsageEvent_businessId_metric_createdAt_idx" ON "BusinessUsageEvent"("businessId", "metric", "createdAt");
ALTER TABLE "BusinessUsageEvent" ADD CONSTRAINT "BusinessUsageEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History tables are never rewritten: refuse UPDATE for every role, the owner included.
CREATE OR REPLACE FUNCTION public.subscriptions_stage_c_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SUBSCRIPTIONS_STAGE_C_APPEND_ONLY: this history is never changed';
END
$fn$;
REVOKE ALL ON FUNCTION public.subscriptions_stage_c_append_only() FROM PUBLIC;
CREATE TRIGGER "PlatformQuotaPolicyEvent_append_only" BEFORE UPDATE ON "PlatformQuotaPolicyEvent"
  FOR EACH ROW EXECUTE FUNCTION public.subscriptions_stage_c_append_only();
CREATE TRIGGER "PlatformTrialClaim_append_only" BEFORE UPDATE OF "kind", "digest", "keyVersion", "outcome", "createdAt" ON "PlatformTrialClaim"
  FOR EACH ROW EXECUTE FUNCTION public.subscriptions_stage_c_append_only();

-- ── B5 seed. The owner's opening matrix (2026-11-24). Monthly per subscription period; TRIAL = the whole 30-day
--    trial; *_bytes metrics are cumulative and never reset. Video stays 0 everywhere (decision 23). FREE_LIMITED
--    creates nothing new; existing data stays readable, downloadable and exportable (the rights floor is in code). ──

INSERT INTO "PlatformQuotaPolicy" ("metric", "tier", "quota") VALUES
  ('business_documents',     'TRIAL', 50),   ('business_documents',     'BASIC', 200),  ('business_documents',     'ADVANCED', 600),  ('business_documents',     'PREMIUM', 2000),  ('business_documents',     'FREE_LIMITED', 0),
  ('document_uploads',       'TRIAL', 100),  ('document_uploads',       'BASIC', 200),  ('document_uploads',       'ADVANCED', 600),  ('document_uploads',       'PREMIUM', 2000),  ('document_uploads',       'FREE_LIMITED', 0),
  ('ocr_pages',              'TRIAL', 150),  ('ocr_pages',              'BASIC', 300),  ('ocr_pages',              'ADVANCED', 1000), ('ocr_pages',              'PREMIUM', 3000),  ('ocr_pages',              'FREE_LIMITED', 0),
  ('storage_customer_bytes', 'TRIAL', 1073741824), ('storage_customer_bytes', 'BASIC', 5368709120), ('storage_customer_bytes', 'ADVANCED', 21474836480),
  ('storage_customer_bytes', 'PREMIUM', 53687091200), ('storage_customer_bytes', 'FREE_LIMITED', 1073741824),
  ('accountant_packages',    'TRIAL', 2),    ('accountant_packages',    'BASIC', 3),    ('accountant_packages',    'ADVANCED', 6),    ('accountant_packages',    'PREMIUM', 12),    ('accountant_packages',    'FREE_LIMITED', 1),
  ('accountant_emails',      'TRIAL', 3),    ('accountant_emails',      'BASIC', 5),    ('accountant_emails',      'ADVANCED', 20),   ('accountant_emails',      'PREMIUM', 50),    ('accountant_emails',      'FREE_LIMITED', 0),
  ('ai_owner_actions',       'TRIAL', 0),    ('ai_owner_actions',       'BASIC', 0),    ('ai_owner_actions',       'ADVANCED', 0),    ('ai_owner_actions',       'PREMIUM', 300),   ('ai_owner_actions',       'FREE_LIMITED', 0),
  ('video_renders',          'TRIAL', 0),    ('video_renders',          'BASIC', 0),    ('video_renders',          'ADVANCED', 0),    ('video_renders',          'PREMIUM', 0),     ('video_renders',          'FREE_LIMITED', 0);

INSERT INTO "PlatformQuotaPolicyEvent" ("metric", "tier", "fromQuota", "toQuota", "reason")
SELECT "metric", "tier", NULL, "quota", 'opening matrix — owner decision 2026-11-24' FROM "PlatformQuotaPolicy";

-- ── A3. The signup writer (auth plane, inside the account transaction) ───────────────────────────────────────
--   p_claims: a JSON array of {"kind": TAX_ID|EMAIL|GOOGLE_SUB|PHONE, "digest": <64 hex>} computed by the app with a
--   server-held key (p_key_version). A TAX_ID, EMAIL or GOOGLE_SUB match on ANY earlier claim means the identity
--   already had a trial: the business opens as a customer WITHOUT a trial (FREE_LIMITED, decision 28). A PHONE match
--   alone never refuses a trial — it is a hint, reported in the result for the admin list.
--   Returns TRIAL_OPENED, TRIAL_OPENED_PHONE_HINT or DUPLICATE_NO_TRIAL. A business that already has a record is
--   refused (nothing written).

CREATE OR REPLACE FUNCTION public.subscription_signup_open(
  p_business integer, p_claims jsonb, p_key_version integer, p_trial_days integer, p_catalog_version text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_claim jsonb;
  v_duplicate boolean := false;
  v_phone_hint boolean := false;
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_outcome text;
BEGIN
  IF p_business IS NULL OR NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SUBSCRIPTION_SIGNUP_NO_BUSINESS';
  END IF;
  IF EXISTS (SELECT 1 FROM public."PlatformSubscription" s WHERE s."businessId" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = 'SUBSCRIPTION_SIGNUP_ALREADY_RECORDED';
  END IF;
  IF p_trial_days IS NULL OR p_trial_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = 'SUBSCRIPTION_SIGNUP_BAD_TRIAL_DAYS';
  END IF;
  IF p_catalog_version IS NULL OR p_catalog_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = 'SUBSCRIPTION_SIGNUP_BAD_CATALOG_VERSION';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' OR jsonb_array_length(p_claims) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = 'SUBSCRIPTION_SIGNUP_BAD_CLAIMS';
  END IF;

  FOR v_claim IN SELECT value FROM jsonb_array_elements(p_claims) LOOP
    IF (v_claim->>'kind') NOT IN ('TAX_ID', 'EMAIL', 'GOOGLE_SUB', 'PHONE') OR (v_claim->>'digest') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = 'SUBSCRIPTION_SIGNUP_BAD_CLAIMS';
    END IF;
    IF EXISTS (SELECT 1 FROM public."PlatformTrialClaim" c
                WHERE c."kind" = v_claim->>'kind' AND c."digest" = v_claim->>'digest' AND c."keyVersion" = p_key_version) THEN
      IF v_claim->>'kind' = 'PHONE' THEN v_phone_hint := true; ELSE v_duplicate := true; END IF;
    END IF;
  END LOOP;

  IF v_duplicate THEN
    INSERT INTO public."PlatformSubscription" ("businessId", "accountType", "status", "plan", "catalogVersion", "source", "updatedAt")
    VALUES (p_business, 'CUSTOMER', 'FREE_LIMITED', NULL, p_catalog_version, 'SIGNUP', v_now);
    INSERT INTO public."PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "toPlan", "reason", "catalogVersion")
    VALUES (p_business, 'SYSTEM_TRANSITION', 'CUSTOMER', 'FREE_LIMITED', NULL, 'signup: identity already had a trial — no second trial', p_catalog_version);
    v_outcome := 'DUPLICATE_NO_TRIAL';
  ELSE
    INSERT INTO public."PlatformSubscription" ("businessId", "accountType", "status", "plan", "catalogVersion", "trialStartedAt", "trialEndsAt", "source", "updatedAt")
    VALUES (p_business, 'CUSTOMER', 'TRIALING', NULL, p_catalog_version, v_now, v_now + make_interval(days => p_trial_days), 'SIGNUP', v_now);
    INSERT INTO public."PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "toPlan", "reason", "catalogVersion")
    VALUES (p_business, 'SYSTEM_TRANSITION', 'CUSTOMER', 'TRIALING', NULL, format('signup: %s-day trial opened', p_trial_days), p_catalog_version);
    v_outcome := CASE WHEN v_phone_hint THEN 'TRIAL_OPENED_PHONE_HINT' ELSE 'TRIAL_OPENED' END;
  END IF;

  INSERT INTO public."PlatformTrialClaim" ("kind", "digest", "keyVersion", "businessId", "outcome")
  SELECT DISTINCT value->>'kind', value->>'digest', p_key_version, p_business,
         CASE WHEN v_duplicate THEN 'DUPLICATE_DETECTED' ELSE 'TRIAL_OPENED' END
    FROM jsonb_array_elements(p_claims);
  RETURN v_outcome;
END
$fn$;
REVOKE ALL ON FUNCTION public.subscription_signup_open(integer, jsonb, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_signup_open(integer, jsonb, integer, integer, text) TO app_auth;

-- ── A4. Trial expiry recorder. Only TRIALING rows whose trialEndsAt has passed; nothing else can be moved by it. ──

CREATE OR REPLACE FUNCTION public.subscription_expire_due_trials(p_max integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_n integer := 0; r record;
BEGIN
  IF p_max IS NULL OR p_max NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = 'SUBSCRIPTION_EXPIRE_BAD_LIMIT';
  END IF;
  FOR r IN
    SELECT s."businessId", s."catalogVersion" FROM public."PlatformSubscription" s
     WHERE s."accountType" = 'CUSTOMER' AND s."status" = 'TRIALING' AND s."trialEndsAt" <= (now() AT TIME ZONE 'UTC')
     ORDER BY s."trialEndsAt" LIMIT p_max FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public."PlatformSubscription" SET "status" = 'FREE_LIMITED', "updatedByUserId" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "businessId" = r."businessId" AND "status" = 'TRIALING';
    INSERT INTO public."PlatformSubscriptionEvent" ("businessId", "kind", "fromAccountType", "toAccountType", "fromStatus", "toStatus", "reason", "catalogVersion")
    VALUES (r."businessId", 'SYSTEM_TRANSITION', 'CUSTOMER', 'CUSTOMER', 'TRIALING', 'FREE_LIMITED', 'trial ended without a plan', r."catalogVersion");
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.subscription_expire_due_trials(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_expire_due_trials(integer) TO app_runtime;

-- ── B10. The quota context of the business in the tenant GUC (helper, not executable by any application role) ──
--   tier: NULL for TESTER / INTERNAL / no record (measured, never limited — decision 24);
--   period: *_bytes metrics → ALL; trial → the trial; a paid period inside its dates → that period; otherwise the
--   calendar month in Israel time.

CREATE OR REPLACE FUNCTION public.usage_quota_context(p_business integer, p_metric text,
  OUT o_account_type text, OUT o_tier text, OUT o_period_key text, OUT o_period_start timestamp(3), OUT o_period_end timestamp(3), OUT o_quota bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  s record;
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_local timestamp := (now() AT TIME ZONE 'Asia/Jerusalem');
  v_base bigint;
  v_override bigint;
  v_add bigint;
BEGIN
  SELECT x."accountType", x."status", x."plan", x."trialStartedAt", x."trialEndsAt", x."currentPeriodStart", x."currentPeriodEnd"
    INTO s FROM public."PlatformSubscription" x WHERE x."businessId" = p_business;
  IF NOT FOUND THEN
    o_account_type := 'NONE';
  ELSE
    o_account_type := s."accountType";
  END IF;

  IF o_account_type = 'CUSTOMER' THEN
    o_tier := CASE s."status" WHEN 'TRIALING' THEN 'TRIAL' WHEN 'FREE_LIMITED' THEN 'FREE_LIMITED'
                              WHEN 'ACTIVE' THEN s."plan" WHEN 'PAST_DUE' THEN s."plan" END;
    -- A trial whose end passed is limited even before the expiry recorder runs.
    IF o_tier = 'TRIAL' AND s."trialEndsAt" <= v_now THEN o_tier := 'FREE_LIMITED'; END IF;
  END IF;

  IF p_metric LIKE '%\_bytes' THEN
    o_period_key := 'ALL';
  ELSIF o_tier = 'TRIAL' AND s."trialStartedAt" IS NOT NULL THEN
    o_period_key := 't:' || to_char(s."trialStartedAt", 'YYYYMMDD"T"HH24MISS');
    o_period_start := s."trialStartedAt"; o_period_end := s."trialEndsAt";
  ELSIF o_tier IN ('BASIC', 'ADVANCED', 'PREMIUM') AND s."currentPeriodStart" IS NOT NULL AND s."currentPeriodEnd" IS NOT NULL
        AND v_now >= s."currentPeriodStart" AND v_now < s."currentPeriodEnd" THEN
    o_period_key := 'p:' || to_char(s."currentPeriodStart", 'YYYYMMDD"T"HH24MISS');
    o_period_start := s."currentPeriodStart"; o_period_end := s."currentPeriodEnd";
  ELSE
    o_period_key := 'm:' || to_char(v_local, 'YYYY-MM');
    o_period_start := (date_trunc('month', v_local) AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'UTC';
    o_period_end := ((date_trunc('month', v_local) + interval '1 month') AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'UTC';
  END IF;

  -- Testers, internal accounts and businesses without a record: measured, never limited (decision 24).
  IF o_tier IS NULL THEN
    o_quota := NULL;
    RETURN;
  END IF;
  SELECT p."quota" INTO v_base FROM public."PlatformQuotaPolicy" p WHERE p."metric" = p_metric AND p."tier" = o_tier;
  IF NOT FOUND THEN
    o_quota := NULL;  -- a measured-only metric: never limited
    RETURN;
  END IF;
  SELECT a."amount" INTO v_override FROM public."BusinessQuotaAdjustment" a
   WHERE a."businessId" = p_business AND a."metric" = p_metric AND a."kind" = 'OVERRIDE' AND a."revokedAt" IS NULL
     AND a."startsAt" <= v_now AND (a."endsAt" IS NULL OR a."endsAt" > v_now)
   ORDER BY a."createdAt" DESC, a."id" DESC LIMIT 1;
  SELECT COALESCE(sum(a."amount"), 0) INTO v_add FROM public."BusinessQuotaAdjustment" a
   WHERE a."businessId" = p_business AND a."metric" = p_metric AND a."kind" = 'ADD' AND a."revokedAt" IS NULL
     AND a."startsAt" <= v_now AND (a."endsAt" IS NULL OR a."endsAt" > v_now);
  o_quota := COALESCE(v_override, v_base) + v_add;
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_quota_context(integer, text) FROM PUBLIC;
-- The admin console computes any business's quota with the same function (read-only).
GRANT EXECUTE ON FUNCTION public.usage_quota_context(integer, text) TO app_admin;

-- The business's own view ("my usage"): the quota context and the used amount of the business in the tenant GUC.
CREATE OR REPLACE FUNCTION public.usage_quota_snapshot(p_metric text)
RETURNS TABLE (tier text, period_key text, period_start timestamp(3), period_end timestamp(3), quota bigint, used bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  c record;
  v_used bigint;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ01', MESSAGE = 'USAGE_NO_TENANT_CONTEXT';
  END IF;
  SELECT * INTO c FROM public.usage_quota_context(v_business, p_metric);
  SELECT k."used" INTO v_used FROM public."BusinessUsageCounter" k
   WHERE k."businessId" = v_business AND k."metric" = p_metric AND k."periodKey" = c.o_period_key;
  RETURN QUERY SELECT c.o_tier, c.o_period_key, c.o_period_start, c.o_period_end, c.o_quota, COALESCE(v_used, 0::bigint);
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_quota_snapshot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_quota_snapshot(text) TO app_runtime;

-- ── B10. usage_consume — count one unit for the business in the tenant GUC. ──────────────────────────────────
--   p_unit_key  what is being counted (a document id, a page range, a storage key): the same key is counted ONCE —
--               a retry answers DUPLICATE and changes nothing.
--   p_reserve   true for a call to an external provider: the unit is RESERVED until usage_settle() says COUNTED
--               (provider charged), RELEASED (proved not charged — the quota is given back) or UNKNOWN (kept counted).
--   p_enforce   the application's mode for this metric (ENFORCE). Even then only a CUSTOMER over its quota is refused
--               (DENIED, nothing recorded); testers, internal accounts and businesses without a record never are.
--   outcome     COUNTED | DUPLICATE | DENIED. verdict on the recorded unit: WITHIN | OVER_SHADOW (a customer over its
--               quota while not enforced) | UNLIMITED (no quota applies: tester, or a measured-only metric).

CREATE OR REPLACE FUNCTION public.usage_consume(
  p_metric text, p_unit_key text, p_amount bigint, p_source text, p_reserve boolean, p_enforce boolean)
RETURNS TABLE (outcome text, used bigint, quota bigint, period_key text, period_end timestamp(3), account_type text, verdict text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
#variable_conflict use_column
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  c record;
  v_used bigint;
  v_verdict text;
  v_prior text;
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ01', MESSAGE = 'USAGE_NO_TENANT_CONTEXT';
  END IF;
  IF p_metric IS NULL OR p_metric !~ '^[a-z][a-z0-9_]{2,39}$' OR p_unit_key IS NULL OR length(p_unit_key) NOT BETWEEN 1 AND 200
     OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 1099511627776 OR p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_.:-]{1,63}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'USAGE_BAD_INPUT';
  END IF;

  SELECT * INTO c FROM public.usage_quota_context(v_business, p_metric);

  INSERT INTO public."BusinessUsageCounter" AS k ("businessId", "metric", "periodKey", "periodStart", "periodEnd", "used", "updatedAt")
  VALUES (v_business, p_metric, c.o_period_key, c.o_period_start, c.o_period_end, 0, v_now)
  ON CONFLICT ("businessId", "metric", "periodKey") DO NOTHING;
  -- The row lock serialises every consumer of this business, metric and period: no two can pass the same last unit.
  SELECT k."used" INTO v_used FROM public."BusinessUsageCounter" k
   WHERE k."businessId" = v_business AND k."metric" = p_metric AND k."periodKey" = c.o_period_key FOR UPDATE;

  SELECT e."verdict" INTO v_prior FROM public."BusinessUsageEvent" e
   WHERE e."businessId" = v_business AND e."metric" = p_metric AND e."unitKey" = p_unit_key;
  IF FOUND THEN
    RETURN QUERY SELECT 'DUPLICATE'::text, v_used, c.o_quota, c.o_period_key, c.o_period_end, c.o_account_type, v_prior;
    RETURN;
  END IF;

  IF c.o_quota IS NULL THEN
    v_verdict := 'UNLIMITED';
  ELSIF v_used + p_amount > c.o_quota THEN
    IF COALESCE(p_enforce, false) AND c.o_account_type = 'CUSTOMER' THEN
      RETURN QUERY SELECT 'DENIED'::text, v_used, c.o_quota, c.o_period_key, c.o_period_end, c.o_account_type, NULL::text;
      RETURN;
    END IF;
    v_verdict := 'OVER_SHADOW';
  ELSE
    v_verdict := 'WITHIN';
  END IF;

  INSERT INTO public."BusinessUsageEvent" ("businessId", "metric", "periodKey", "unitKey", "amount", "state", "verdict", "source", "createdAt", "settledAt")
  VALUES (v_business, p_metric, c.o_period_key, p_unit_key, p_amount,
          CASE WHEN COALESCE(p_reserve, false) THEN 'RESERVED' ELSE 'COUNTED' END, v_verdict, p_source, v_now,
          CASE WHEN COALESCE(p_reserve, false) THEN NULL ELSE v_now END);
  UPDATE public."BusinessUsageCounter" k SET "used" = k."used" + p_amount, "updatedAt" = v_now
   WHERE k."businessId" = v_business AND k."metric" = p_metric AND k."periodKey" = c.o_period_key
  RETURNING k."used" INTO v_used;
  RETURN QUERY SELECT 'COUNTED'::text, v_used, c.o_quota, c.o_period_key, c.o_period_end, c.o_account_type, v_verdict;
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_consume(text, text, bigint, text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_consume(text, text, bigint, text, boolean, boolean) TO app_runtime;

-- ── B10. usage_settle — move a recorded unit: RESERVED → COUNTED | RELEASED | UNKNOWN; COUNTED → RELEASED (a stored
--   file deleted, a refund); UNKNOWN → COUNTED | RELEASED (reconciliation). RELEASED gives the amount back to the
--   counter of the unit's own period. Returns the new state, or NOOP when the unit is unknown or the move not allowed. ──

CREATE OR REPLACE FUNCTION public.usage_settle(p_metric text, p_unit_key text, p_state text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_id bigint;
  v_amount bigint;
  v_period text;
  v_state text;
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ01', MESSAGE = 'USAGE_NO_TENANT_CONTEXT';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('COUNTED', 'RELEASED', 'UNKNOWN') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'USAGE_BAD_INPUT';
  END IF;
  SELECT x."id", x."amount", x."periodKey" INTO v_id, v_amount, v_period FROM public."BusinessUsageEvent" x
   WHERE x."businessId" = v_business AND x."metric" = p_metric AND x."unitKey" = p_unit_key;
  IF NOT FOUND THEN RETURN 'NOOP'; END IF;
  -- Lock the counter first (the order usage_consume takes), then the unit.
  PERFORM 1 FROM public."BusinessUsageCounter" k
   WHERE k."businessId" = v_business AND k."metric" = p_metric AND k."periodKey" = v_period FOR UPDATE;
  SELECT x."state" INTO v_state FROM public."BusinessUsageEvent" x WHERE x."id" = v_id FOR UPDATE;
  IF NOT ((v_state = 'RESERVED' AND p_state IN ('COUNTED', 'RELEASED', 'UNKNOWN'))
          OR (v_state = 'COUNTED' AND p_state = 'RELEASED')
          OR (v_state = 'UNKNOWN' AND p_state IN ('COUNTED', 'RELEASED'))) THEN
    RETURN 'NOOP';
  END IF;
  UPDATE public."BusinessUsageEvent" SET "state" = p_state, "settledAt" = v_now WHERE "id" = v_id;
  IF p_state = 'RELEASED' THEN
    UPDATE public."BusinessUsageCounter" SET "used" = GREATEST("used" - v_amount, 0), "updatedAt" = v_now
     WHERE "businessId" = v_business AND "metric" = p_metric AND "periodKey" = v_period;
  END IF;
  RETURN p_state;
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_settle(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_settle(text, text, text) TO app_runtime;

-- ── B10. usage_mark_alert — record the highest threshold already notified for the current period (80 / 90 / 100),
--   so a notification is sent once. Returns true when this call raised it (the caller notifies), false otherwise. ──

CREATE OR REPLACE FUNCTION public.usage_mark_alert(p_metric text, p_period_key text, p_pct integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ01', MESSAGE = 'USAGE_NO_TENANT_CONTEXT';
  END IF;
  IF p_pct NOT IN (80, 90, 100) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'USAGE_BAD_INPUT';
  END IF;
  UPDATE public."BusinessUsageCounter" SET "alertedPct" = p_pct
   WHERE "businessId" = v_business AND "metric" = p_metric AND "periodKey" = p_period_key AND "alertedPct" < p_pct;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_mark_alert(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_mark_alert(text, text, integer) TO app_runtime;

-- ── B11. Admin writers (app_admin only). Each checks the actor is a PLATFORM_ADMIN and writes its audit row. ──

CREATE OR REPLACE FUNCTION public.subscriptions_require_platform_admin(p_admin integer)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET TimeZone = 'UTC' AS $fn$
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_admin AND u."role"::text = 'PLATFORM_ADMIN') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ10', MESSAGE = 'SUBSCRIPTIONS_ADMIN_REQUIRED';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.subscriptions_require_platform_admin(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.quota_policy_set(p_admin integer, p_metric text, p_tier text, p_quota bigint, p_reason text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_from bigint; v_event bigint;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'QUOTA_POLICY_REASON_REQUIRED';
  END IF;
  SELECT p."quota" INTO v_from FROM public."PlatformQuotaPolicy" p WHERE p."metric" = p_metric AND p."tier" = p_tier FOR UPDATE;
  IF FOUND THEN
    UPDATE public."PlatformQuotaPolicy" SET "quota" = p_quota, "version" = "version" + 1, "updatedByUserId" = p_admin, "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "metric" = p_metric AND "tier" = p_tier;
  ELSE
    INSERT INTO public."PlatformQuotaPolicy" ("metric", "tier", "quota", "updatedByUserId") VALUES (p_metric, p_tier, p_quota, p_admin);
  END IF;
  INSERT INTO public."PlatformQuotaPolicyEvent" ("metric", "tier", "fromQuota", "toQuota", "actorUserId", "reason")
  VALUES (p_metric, p_tier, v_from, p_quota, p_admin, btrim(p_reason)) RETURNING "id" INTO v_event;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_QUOTA_POLICY_UPDATED', 'QuotaPolicy', p_metric || ':' || p_tier,
          jsonb_build_object('metric', p_metric, 'tier', p_tier, 'from', v_from, 'to', p_quota, 'reason', btrim(p_reason)));
  RETURN v_event;
END
$fn$;
REVOKE ALL ON FUNCTION public.quota_policy_set(integer, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_policy_set(integer, text, text, bigint, text) TO app_admin;

CREATE OR REPLACE FUNCTION public.quota_adjustment_add(
  p_admin integer, p_business integer, p_metric text, p_kind text, p_amount bigint, p_ends_at timestamp, p_reason text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_id bigint;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ11', MESSAGE = 'QUOTA_ADJUSTMENT_NO_BUSINESS';
  END IF;
  INSERT INTO public."BusinessQuotaAdjustment" ("businessId", "metric", "kind", "amount", "endsAt", "source", "reason", "createdByUserId")
  VALUES (p_business, p_metric, p_kind, p_amount, p_ends_at, 'ADMIN', btrim(p_reason), p_admin) RETURNING "id" INTO v_id;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_QUOTA_ADJUSTED', 'Business', p_business::text,
          jsonb_build_object('adjustmentId', v_id, 'metric', p_metric, 'kind', p_kind, 'amount', p_amount, 'endsAt', p_ends_at, 'reason', btrim(p_reason)));
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.quota_adjustment_add(integer, integer, text, text, bigint, timestamp, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_adjustment_add(integer, integer, text, text, bigint, timestamp, text) TO app_admin;

CREATE OR REPLACE FUNCTION public.quota_adjustment_revoke(p_admin integer, p_id bigint, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_business integer;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  UPDATE public."BusinessQuotaAdjustment" SET "revokedAt" = (now() AT TIME ZONE 'UTC'), "revokedByUserId" = p_admin, "revokeReason" = btrim(p_reason)
   WHERE "id" = p_id AND "revokedAt" IS NULL RETURNING "businessId" INTO v_business;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_QUOTA_ADJUSTMENT_REVOKED', 'Business', v_business::text,
          jsonb_build_object('adjustmentId', p_id, 'reason', btrim(p_reason)));
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.quota_adjustment_revoke(integer, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_adjustment_revoke(integer, bigint, text) TO app_admin;

CREATE OR REPLACE FUNCTION public.subscription_request_resolve(p_admin integer, p_id bigint, p_status text, p_note text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_business integer;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  IF p_status NOT IN ('HANDLED', 'DISMISSED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'SUBSCRIPTION_REQUEST_BAD_STATUS';
  END IF;
  UPDATE public."PlatformSubscriptionRequest" SET "status" = p_status, "handledAt" = (now() AT TIME ZONE 'UTC'), "handledByUserId" = p_admin,
         "handledNote" = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE "id" = p_id AND "status" = 'OPEN' RETURNING "businessId" INTO v_business;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_SUBSCRIPTION_REQUEST_RESOLVED', 'Business', v_business::text,
          jsonb_build_object('requestId', p_id, 'status', p_status));
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.subscription_request_resolve(integer, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_request_resolve(integer, bigint, text, text) TO app_admin;

CREATE OR REPLACE FUNCTION public.usage_metric_mode_set(p_admin integer, p_metric text, p_mode text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_from text;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'USAGE_MODE_REASON_REQUIRED';
  END IF;
  SELECT m."mode" INTO v_from FROM public."PlatformUsageMetricMode" m WHERE m."metric" = p_metric FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public."PlatformUsageMetricMode" ("metric", "mode", "updatedByUserId") VALUES (p_metric, p_mode, p_admin);
  ELSIF v_from = p_mode THEN
    RETURN false;
  ELSE
    UPDATE public."PlatformUsageMetricMode" SET "mode" = p_mode, "updatedByUserId" = p_admin, "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "metric" = p_metric;
  END IF;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_USAGE_MODE_UPDATED', 'UsageMetric', p_metric,
          jsonb_build_object('metric', p_metric, 'from', v_from, 'to', p_mode, 'reason', btrim(p_reason)));
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.usage_metric_mode_set(integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_metric_mode_set(integer, text, text, text) TO app_admin;

-- An admin may record a claim by hand (a false-positive fix is done by opening a trial through the stage B admin
-- path; recording a claim marks an identity as having had a trial).
CREATE OR REPLACE FUNCTION public.trial_claim_admin_record(p_admin integer, p_business integer, p_kind text, p_digest text, p_key_version integer, p_reason text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE v_id bigint;
BEGIN
  PERFORM public.subscriptions_require_platform_admin(p_admin);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZQ02', MESSAGE = 'TRIAL_CLAIM_REASON_REQUIRED';
  END IF;
  INSERT INTO public."PlatformTrialClaim" ("kind", "digest", "keyVersion", "businessId", "outcome")
  VALUES (p_kind, p_digest, p_key_version, p_business, 'ADMIN_RECORDED') RETURNING "id" INTO v_id;
  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata")
  VALUES (p_admin, 'PLATFORM_TRIAL_CLAIM_RECORDED', 'Business', p_business::text,
          jsonb_build_object('claimId', v_id, 'kind', p_kind, 'reason', btrim(p_reason)));
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.trial_claim_admin_record(integer, integer, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_claim_admin_record(integer, integer, text, text, integer, text) TO app_admin;

-- ── FORCE RLS, per-command policies, exact grants ────────────────────────────────────────────────────────────

ALTER TABLE "PlatformTrialClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformTrialClaim" FORCE ROW LEVEL SECURITY;
-- No runtime policy: the runtime role is granted SELECT by name (R2) and sees zero rows. Writes: definer functions only.
CREATE POLICY platform_trial_claim_ctl_select ON "PlatformTrialClaim" FOR SELECT TO app_ctlplane
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PlatformSubscriptionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformSubscriptionRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_subscription_request_tenant_select ON "PlatformSubscriptionRequest" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY platform_subscription_request_tenant_insert ON "PlatformSubscriptionRequest" FOR INSERT TO app_runtime
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int AND "status" = 'OPEN'
              AND "handledAt" IS NULL AND "handledByUserId" IS NULL AND "handledNote" IS NULL);

ALTER TABLE "BusinessQuotaAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessQuotaAdjustment" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_quota_adjustment_tenant_select ON "BusinessQuotaAdjustment" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessUsageCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessUsageCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_usage_counter_tenant_select ON "BusinessUsageCounter" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessUsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessUsageEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_usage_event_tenant_select ON "BusinessUsageEvent" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Admin console read (app_admin: NOLOGIN group, NOBYPASSRLS, read-only) — the additive p7adm_read pattern.
CREATE POLICY p7adm_read ON "PlatformSubscription" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "PlatformSubscriptionEvent" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "PlatformTrialClaim" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "PlatformSubscriptionRequest" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "BusinessQuotaAdjustment" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "BusinessUsageCounter" FOR SELECT TO app_admin USING (true);
CREATE POLICY p7adm_read ON "BusinessUsageEvent" FOR SELECT TO app_admin USING (true);

-- Grants: exactly what each role needs; default privileges on the new objects are removed first.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
           pg_get_userbyid(x.grantee) AS grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('PlatformTrialClaim', 'PlatformTrialClaim_id_seq', 'PlatformSubscriptionRequest', 'PlatformSubscriptionRequest_id_seq',
                         'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent', 'PlatformQuotaPolicyEvent_id_seq',
                         'BusinessQuotaAdjustment', 'BusinessQuotaAdjustment_id_seq', 'BusinessUsageCounter',
                         'BusinessUsageEvent', 'BusinessUsageEvent_id_seq', 'PlatformUsageMetricMode')
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %I', r.kind, r.rel, r.grantee);
  END LOOP;
END
$do$;

-- Runtime: reads its own business's rows (policies above); the trial claims by name only (zero rows); the policy
-- table (global, no business column) in full; files requests for its own business. Every counter / ledger / claim /
-- adjustment write goes through the definer functions.
GRANT SELECT ON "PlatformTrialClaim" TO app_runtime;
GRANT SELECT, INSERT ON "PlatformSubscriptionRequest" TO app_runtime;
GRANT USAGE ON SEQUENCE "PlatformSubscriptionRequest_id_seq" TO app_runtime;
GRANT SELECT ON "PlatformQuotaPolicy" TO app_runtime;
GRANT SELECT ON "PlatformUsageMetricMode" TO app_runtime;
GRANT SELECT ON "BusinessQuotaAdjustment" TO app_runtime;
GRANT SELECT ON "BusinessUsageCounter" TO app_runtime;
GRANT SELECT ON "BusinessUsageEvent" TO app_runtime;
-- Control plane: nothing new except reading its target business's claims (admin trial decisions).
GRANT SELECT ON "PlatformTrialClaim" TO app_ctlplane;
-- Admin console: read everything of the stage (rows through the p7adm_read policies above).
GRANT SELECT ON "PlatformSubscription", "PlatformSubscriptionEvent", "PlatformTrialClaim", "PlatformSubscriptionRequest",
                "PlatformQuotaPolicy", "PlatformQuotaPolicyEvent", "BusinessQuotaAdjustment", "BusinessUsageCounter",
                "BusinessUsageEvent", "PlatformUsageMetricMode" TO app_admin;
