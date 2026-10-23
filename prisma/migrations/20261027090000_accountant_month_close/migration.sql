-- Monthly accountant workflow — data foundation (owner decision Option B, D1–D8, 2026-10-21)
--
-- WHAT THIS ADDS (five tenant tables, four functions, one flag; nothing existing is changed)
--   "AccountantPeriod"        one row per business per Israeli calendar month: workflow status, readiness
--                             counts (closed shape, no text), content fingerprint, evaluation lease,
--                             reminder bookkeeping, completion.
--   "AccountantPackage"       an immutable package version: fingerprint, private storage key (DB-pinned to
--                             the business's own prefix), sha256, size, manifest (counts and ids only).
--                             Once READY nothing about it can change except READY → SUPERSEDED.
--   "AccountantRecipient"     the accountant's name and email, one per business, versioned.
--   "AccountantDelivery"      one owner approval to send one package version to one recipient version,
--                             and its sending / provider / download outcome. The approval columns are
--                             immutable; the recipient snapshot may only be erased (set NULL).
--   "AccountantWorkflowEvent" the append-only audit trail (who did what, when; closed payload, no text).
--
-- ISOLATION
--   Every table: ENABLE + FORCE RLS, per-command policies on app.current_business_id, explicit grants.
--   No DELETE for the runtime anywhere except the recipient row (account erasure, RLS-bound). Cross-tenant references are refused by the
--   database: composite (businessId, id) foreign keys between the tables, and a trigger for user columns.
--
-- FUNCTIONS (SECURITY DEFINER, owned by the migration role, EXECUTE revoked from PUBLIC)
--   accountant_link_resolve(public_id, token_hash)  the accountant's download link → (business, delivery).
--     It returns ids only and only when BOTH the public id and the sha256 of the secret match; the
--     caller then reads the delivery under RLS in that business's tenant transaction.
--   accountant_delivery_by_provider_message(provider, message_id)  a provider webhook → (business,
--     delivery). Ids only.
--   accountant_erase_business()  account erasure: nulls the acting users of the append-only trail — only
--     for the business in the tenant context and only while that business is being deleted (the adapter
--     erases the recipient and the delivery snapshots itself, through RLS).
--   accountant_user_same_business()  trigger function (not callable directly).
--
-- FLAG
--   accountant_month_close — defaultEnabled FALSE, globalEnabled FALSE: OFF for every business. Controlled
--   verification is a business override; the general rollout (owner gate G5) flips the default and the policy
--   row together. Sending is a second, separate switch outside the database (ACCOUNTANT_DELIVERY_ENABLED, G4).
--
-- Additive. Rollback: .acct/rollback.sql (owner-run; refuses while rows exist).

-- ── 1. AccountantPeriod ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantPeriod" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "periodKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "readiness" JSONB NOT NULL DEFAULT '{}',
  "contentFingerprint" TEXT,
  "latestPackageId" INTEGER,
  "dirtyAt" TIMESTAMP(3),
  "evaluatedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "notifiedStatus" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "remindersSent" INTEGER NOT NULL DEFAULT 0,
  "lastReminderAt" TIMESTAMP(3),
  "changedSinceSent" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3),
  "completionKind" TEXT,
  "completedPackageId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountantPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantPeriod_periodKey_shape" CHECK ("periodKey" ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'),
  CONSTRAINT "AccountantPeriod_status" CHECK ("status" IN (
    'NEEDS_ATTENTION', 'PREPARING', 'PREPARATION_FAILED', 'READY_FOR_REVIEW',
    'SENDING', 'SENT', 'SEND_FAILED', 'COMPLETED_MANUALLY')),
  CONSTRAINT "AccountantPeriod_notifiedStatus" CHECK ("notifiedStatus" IS NULL OR "notifiedStatus" IN (
    'NEEDS_ATTENTION', 'PREPARATION_FAILED', 'READY_FOR_REVIEW', 'SEND_FAILED', 'CHANGED_AFTER_SEND')),
  CONSTRAINT "AccountantPeriod_completionKind" CHECK ("completionKind" IS NULL OR "completionKind" IN ('DELIVERY', 'MANUAL')),
  CONSTRAINT "AccountantPeriod_completion_shape" CHECK (("completedAt" IS NULL) = ("completionKind" IS NULL) AND ("completedAt" IS NULL) = ("completedPackageId" IS NULL)),
  CONSTRAINT "AccountantPeriod_fingerprint" CHECK ("contentFingerprint" IS NULL OR "contentFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountantPeriod_failureCode" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Za-z0-9_:.-]{1,64}$'),
  CONSTRAINT "AccountantPeriod_counters" CHECK ("attempts" >= 0 AND "remindersSent" BETWEEN 0 AND 10),
  -- Readiness is counts, booleans, ids and short tokens — never free text.
  CONSTRAINT "AccountantPeriod_readiness_closed" CHECK (
        jsonb_typeof("readiness") = 'object'
    AND octet_length("readiness"::text) <= 16384
    AND NOT jsonb_path_exists("readiness", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AccountantPeriod_businessId_periodKey_key" ON "AccountantPeriod"("businessId", "periodKey");
CREATE UNIQUE INDEX "AccountantPeriod_businessId_id_key" ON "AccountantPeriod"("businessId", "id");
CREATE INDEX "AccountantPeriod_status_idx" ON "AccountantPeriod"("status");
CREATE INDEX "AccountantPeriod_dirtyAt_idx" ON "AccountantPeriod"("dirtyAt") WHERE "dirtyAt" IS NOT NULL;
ALTER TABLE "AccountantPeriod" ADD CONSTRAINT "AccountantPeriod_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. AccountantPackage ────────────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantPackage" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "periodId" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "contentFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "storageKey" TEXT,
  "sha256" TEXT,
  "sizeBytes" INTEGER,
  "manifest" JSONB NOT NULL DEFAULT '{}',
  "openItemCount" INTEGER NOT NULL DEFAULT 0,
  "builtByUserId" INTEGER,
  "leaseUntil" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "readyAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "AccountantPackage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantPackage_status" CHECK ("status" IN ('BUILDING', 'READY', 'FAILED', 'SUPERSEDED')),
  CONSTRAINT "AccountantPackage_version" CHECK ("version" >= 1),
  CONSTRAINT "AccountantPackage_fingerprint" CHECK ("contentFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountantPackage_sha256" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountantPackage_size" CHECK ("sizeBytes" IS NULL OR "sizeBytes" > 0),
  CONSTRAINT "AccountantPackage_open_items" CHECK ("openItemCount" >= 0),
  CONSTRAINT "AccountantPackage_failureCode" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Za-z0-9_:.-]{1,64}$'),
  -- The object lives under THIS business's private exports prefix, and nowhere else.
  CONSTRAINT "AccountantPackage_storage_key_tenant" CHECK (
    "storageKey" IS NULL OR (
          left("storageKey", char_length('biz/' || "businessId"::text || '/exports/accountant/'))
            = 'biz/' || "businessId"::text || '/exports/accountant/'
      AND "storageKey" ~ '^biz/[0-9]+/exports/accountant/[0-9]{4}-[0-9]{2}/[A-Za-z0-9_.-]{1,120}\.zip$')),
  -- READY means a stored, hashed object; FAILED and BUILDING carry none of it.
  CONSTRAINT "AccountantPackage_ready_shape" CHECK (
    CASE "status"
      WHEN 'READY'      THEN "storageKey" IS NOT NULL AND "sha256" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "readyAt" IS NOT NULL
      WHEN 'SUPERSEDED' THEN "storageKey" IS NOT NULL AND "sha256" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "supersededAt" IS NOT NULL
      ELSE "sha256" IS NULL AND "readyAt" IS NULL
    END),
  CONSTRAINT "AccountantPackage_manifest_closed" CHECK (
        jsonb_typeof("manifest") = 'object'
    AND octet_length("manifest"::text) <= 16384
    AND NOT jsonb_path_exists("manifest", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AccountantPackage_periodId_version_key" ON "AccountantPackage"("periodId", "version");
CREATE UNIQUE INDEX "AccountantPackage_businessId_id_key" ON "AccountantPackage"("businessId", "id");
-- At most one build in flight per period (a duplicate scheduler run loses the race here).
CREATE UNIQUE INDEX "AccountantPackage_one_building_per_period" ON "AccountantPackage"("periodId") WHERE "status" = 'BUILDING';
CREATE INDEX "AccountantPackage_businessId_status_idx" ON "AccountantPackage"("businessId", "status");
ALTER TABLE "AccountantPackage" ADD CONSTRAINT "AccountantPackage_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantPackage" ADD CONSTRAINT "AccountantPackage_period_tenant_fkey"
  FOREIGN KEY ("businessId", "periodId") REFERENCES "AccountantPeriod"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AccountantPeriod" ADD CONSTRAINT "AccountantPeriod_latestPackage_tenant_fkey"
  FOREIGN KEY ("businessId", "latestPackageId") REFERENCES "AccountantPackage"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AccountantPeriod" ADD CONSTRAINT "AccountantPeriod_completedPackage_tenant_fkey"
  FOREIGN KEY ("businessId", "completedPackageId") REFERENCES "AccountantPackage"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AccountantPackage" ADD CONSTRAINT "AccountantPackage_builtByUserId_fkey"
  FOREIGN KEY ("builtByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. AccountantRecipient ──────────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantRecipient" (
  "businessId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountantRecipient_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "AccountantRecipient_version" CHECK ("version" >= 1),
  CONSTRAINT "AccountantRecipient_name" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120 AND "name" !~ '[\x00-\x1F\x7F]'),
  -- Stored normalised (trimmed, lower-case); the application validates the full shape first.
  CONSTRAINT "AccountantRecipient_email" CHECK (
        char_length("email") BETWEEN 3 AND 254
    AND "email" = lower(btrim("email"))
    AND "email" ~ '^[^@\s<>",;:\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
ALTER TABLE "AccountantRecipient" ADD CONSTRAINT "AccountantRecipient_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantRecipient" ADD CONSTRAINT "AccountantRecipient_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. AccountantDelivery ───────────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantDelivery" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "periodId" INTEGER NOT NULL,
  "packageId" INTEGER NOT NULL,
  "packageVersion" INTEGER NOT NULL,
  "packageSha256" TEXT NOT NULL,
  "recipientVersion" INTEGER NOT NULL,
  "recipientName" TEXT,
  "recipientEmail" TEXT,
  "approvedByUserId" INTEGER,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "incompleteAcknowledged" BOOLEAN NOT NULL,
  "openItemCount" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "failureCode" TEXT,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "linkPublicId" TEXT NOT NULL,
  "linkTokenHash" TEXT NOT NULL,
  "linkExpiresAt" TIMESTAMP(3) NOT NULL,
  "linkRevokedAt" TIMESTAMP(3),
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "firstDownloadedAt" TIMESTAMP(3),
  "lastDownloadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountantDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantDelivery_status" CHECK ("status" IN (
    'APPROVED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'BOUNCED', 'CANCELED')),
  CONSTRAINT "AccountantDelivery_sha256" CHECK ("packageSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountantDelivery_versions" CHECK ("packageVersion" >= 1 AND "recipientVersion" >= 1),
  -- D2: an approval with open items exists only together with the explicit "send anyway" acknowledgement.
  CONSTRAINT "AccountantDelivery_incomplete_acknowledged" CHECK ("openItemCount" >= 0 AND ("openItemCount" = 0 OR "incompleteAcknowledged")),
  CONSTRAINT "AccountantDelivery_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND "linkPublicId" ~ '^[A-Za-z0-9_-]{32}$'
    AND "linkTokenHash" ~ '^[0-9a-f]{64}$'
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Za-z0-9_:.-]{1,64}$')
    AND ("provider" IS NULL OR "provider" ~ '^[a-z0-9_-]{1,40}$')
    AND ("providerMessageId" IS NULL OR "providerMessageId" ~ '^[A-Za-z0-9_:.-]{1,128}$')),
  -- D3: the link lives 14 days from the approval (a day of slack for the send itself).
  CONSTRAINT "AccountantDelivery_link_lifetime" CHECK (
    "linkExpiresAt" > "approvedAt" AND "linkExpiresAt" <= "approvedAt" + interval '15 days'),
  CONSTRAINT "AccountantDelivery_recipient_snapshot" CHECK (
        ("recipientName" IS NULL OR char_length("recipientName") BETWEEN 1 AND 120)
    AND ("recipientEmail" IS NULL OR (char_length("recipientEmail") BETWEEN 3 AND 254 AND "recipientEmail" = lower("recipientEmail")))),
  CONSTRAINT "AccountantDelivery_counters" CHECK ("attempts" BETWEEN 0 AND 20 AND "downloadCount" >= 0)
);
CREATE UNIQUE INDEX "AccountantDelivery_businessId_id_key" ON "AccountantDelivery"("businessId", "id");
CREATE UNIQUE INDEX "AccountantDelivery_businessId_idempotencyKey_key" ON "AccountantDelivery"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "AccountantDelivery_linkPublicId_key" ON "AccountantDelivery"("linkPublicId");
CREATE UNIQUE INDEX "AccountantDelivery_linkTokenHash_key" ON "AccountantDelivery"("linkTokenHash");
CREATE UNIQUE INDEX "AccountantDelivery_provider_message_key" ON "AccountantDelivery"("provider", "providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;
-- One send in flight per period: a second approval while one is waiting or sending is refused.
CREATE UNIQUE INDEX "AccountantDelivery_one_in_flight_per_period" ON "AccountantDelivery"("periodId")
  WHERE "status" IN ('APPROVED', 'SENDING');
CREATE INDEX "AccountantDelivery_status_nextAttemptAt_idx" ON "AccountantDelivery"("status", "nextAttemptAt");
CREATE INDEX "AccountantDelivery_businessId_periodId_idx" ON "AccountantDelivery"("businessId", "periodId");
ALTER TABLE "AccountantDelivery" ADD CONSTRAINT "AccountantDelivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantDelivery" ADD CONSTRAINT "AccountantDelivery_period_tenant_fkey"
  FOREIGN KEY ("businessId", "periodId") REFERENCES "AccountantPeriod"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AccountantDelivery" ADD CONSTRAINT "AccountantDelivery_package_tenant_fkey"
  FOREIGN KEY ("businessId", "packageId") REFERENCES "AccountantPackage"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AccountantDelivery" ADD CONSTRAINT "AccountantDelivery_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 5. AccountantWorkflowEvent — the append-only trail ──────────────────────────────────────────

CREATE TABLE "AccountantWorkflowEvent" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "periodId" INTEGER,
  "packageId" INTEGER,
  "deliveryId" INTEGER,
  "eventType" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "actorUserId" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  CONSTRAINT "AccountantWorkflowEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantWorkflowEvent_type" CHECK ("eventType" IN (
    'PERIOD_EVALUATED', 'PACKAGE_BUILT', 'PACKAGE_BUILD_FAILED', 'PACKAGE_SUPERSEDED', 'PACKAGE_DOWNLOADED_BY_OWNER',
    'ISSUED_PDFS_PREPARED', 'NOTIFIED', 'REMINDED', 'CHANGED_AFTER_SEND',
    'RECIPIENT_SET', 'RECIPIENT_CHANGED',
    'DELIVERY_APPROVED', 'DELIVERY_CANCELED', 'DELIVERY_SENDING', 'DELIVERY_RETRY_SCHEDULED', 'DELIVERY_ACCEPTED',
    'DELIVERY_DELIVERED', 'DELIVERY_BOUNCED', 'DELIVERY_FAILED',
    'LINK_DOWNLOADED', 'LINK_REFUSED', 'LINK_REVOKED',
    'PERIOD_COMPLETED', 'PERIOD_COMPLETED_MANUALLY')),
  CONSTRAINT "AccountantWorkflowEvent_actor" CHECK ("actor" IN ('OWNER_USER', 'SYSTEM', 'RECIPIENT', 'PROVIDER')),
  CONSTRAINT "AccountantWorkflowEvent_actor_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "AccountantWorkflowEvent_key" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'),
  CONSTRAINT "AccountantWorkflowEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AccountantWorkflowEvent_businessId_idempotencyKey_key" ON "AccountantWorkflowEvent"("businessId", "idempotencyKey");
CREATE INDEX "AccountantWorkflowEvent_businessId_periodId_idx" ON "AccountantWorkflowEvent"("businessId", "periodId");
CREATE INDEX "AccountantWorkflowEvent_businessId_deliveryId_idx" ON "AccountantWorkflowEvent"("businessId", "deliveryId");
ALTER TABLE "AccountantWorkflowEvent" ADD CONSTRAINT "AccountantWorkflowEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantWorkflowEvent" ADD CONSTRAINT "AccountantWorkflowEvent_period_tenant_fkey"
  FOREIGN KEY ("businessId", "periodId") REFERENCES "AccountantPeriod"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AccountantWorkflowEvent" ADD CONSTRAINT "AccountantWorkflowEvent_package_tenant_fkey"
  FOREIGN KEY ("businessId", "packageId") REFERENCES "AccountantPackage"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AccountantWorkflowEvent" ADD CONSTRAINT "AccountantWorkflowEvent_delivery_tenant_fkey"
  FOREIGN KEY ("businessId", "deliveryId") REFERENCES "AccountantDelivery"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AccountantWorkflowEvent" ADD CONSTRAINT "AccountantWorkflowEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 6. User references stay inside the business ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.accountant_user_same_business()
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
        ERRCODE = 'DZA01',
        MESSAGE = format('ACCOUNTANT_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_user_same_business() FROM PUBLIC;

CREATE TRIGGER "AccountantPackage_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "builtByUserId" ON "AccountantPackage"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_user_same_business('builtByUserId');
CREATE TRIGGER "AccountantRecipient_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "updatedByUserId" ON "AccountantRecipient"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_user_same_business('updatedByUserId');
CREATE TRIGGER "AccountantDelivery_user_same_business"
  BEFORE INSERT ON "AccountantDelivery"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_user_same_business('approvedByUserId');
CREATE TRIGGER "AccountantWorkflowEvent_user_same_business"
  BEFORE INSERT ON "AccountantWorkflowEvent"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_user_same_business('actorUserId');

-- ── 7. Package immutability ─────────────────────────────────────────────────────────────────────
-- BUILDING → READY | FAILED; READY → SUPERSEDED; FAILED and SUPERSEDED are final. A READY or
-- SUPERSEDED package's identity (period, version, fingerprint, object, hash, size, manifest) never
-- changes — the approval of a send names exactly that object.

CREATE OR REPLACE FUNCTION public.accountant_package_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  frozen constant text[] := ARRAY['id', 'businessId', 'periodId', 'version', 'contentFingerprint'];
  sealed constant text[] := ARRAY['storageKey', 'sha256', 'sizeBytes', 'manifest', 'openItemCount', 'readyAt', 'createdAt'];
  k text;
BEGIN
  FOREACH k IN ARRAY frozen LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZA02', MESSAGE = format('ACCOUNTANT_PACKAGE_FROZEN: %s cannot change', k);
    END IF;
  END LOOP;
  IF OLD."status" IN ('READY', 'SUPERSEDED', 'FAILED') THEN
    FOREACH k IN ARRAY sealed LOOP
      IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
        RAISE EXCEPTION USING ERRCODE = 'DZA02', MESSAGE = format('ACCOUNTANT_PACKAGE_SEALED: %s of a finished package cannot change', k);
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       NEW."status" = OLD."status" AND OLD."status" = 'BUILDING'
    OR (OLD."status" = 'BUILDING' AND NEW."status" IN ('READY', 'FAILED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN ('READY', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA02', MESSAGE = format('ACCOUNTANT_PACKAGE_TRANSITION: %s → %s is refused', OLD."status", NEW."status");
  END IF;
  -- A FK action (builtByUserId ON DELETE SET NULL) is the only change a finished package accepts besides SUPERSEDED.
  IF OLD."status" IN ('READY', 'SUPERSEDED') AND NEW."status" = OLD."status"
     AND (to_jsonb(NEW) - 'builtByUserId') IS DISTINCT FROM (to_jsonb(OLD) - 'builtByUserId') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA02', MESSAGE = 'ACCOUNTANT_PACKAGE_SEALED: a finished package cannot change';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_package_guard() FROM PUBLIC;
CREATE TRIGGER "AccountantPackage_guard" BEFORE UPDATE ON "AccountantPackage"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_package_guard();

-- ── 8. Delivery: the approval is immutable; statuses only move forward ──────────────────────────

CREATE OR REPLACE FUNCTION public.accountant_delivery_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  p record;
BEGIN
  IF NEW."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA03', MESSAGE = 'ACCOUNTANT_DELIVERY_BIRTH: a delivery is born APPROVED';
  END IF;
  -- The approval names a READY package of the same period, by its exact version and hash.
  SELECT k."status", k."periodId", k."version", k."sha256" INTO p
    FROM "AccountantPackage" k WHERE k."id" = NEW."packageId" AND k."businessId" = NEW."businessId";
  IF NOT FOUND OR p."status" <> 'READY' OR p."periodId" <> NEW."periodId"
     OR p."version" <> NEW."packageVersion" OR p."sha256" <> NEW."packageSha256" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA03', MESSAGE = 'ACCOUNTANT_DELIVERY_PACKAGE: the approval must name the current READY package exactly';
  END IF;
  IF NEW."recipientName" IS NULL OR NEW."recipientEmail" IS NULL OR NEW."approvedByUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA03', MESSAGE = 'ACCOUNTANT_DELIVERY_BIRTH: recipient and approver are required';
  END IF;
  IF NEW."attempts" <> 0 OR NEW."downloadCount" <> 0 OR NEW."providerMessageId" IS NOT NULL OR NEW."linkRevokedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA03', MESSAGE = 'ACCOUNTANT_DELIVERY_BIRTH: a new delivery carries no outcome';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_delivery_insert_guard() FROM PUBLIC;
CREATE TRIGGER "AccountantDelivery_insert_guard" BEFORE INSERT ON "AccountantDelivery"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_delivery_insert_guard();

CREATE OR REPLACE FUNCTION public.accountant_delivery_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  frozen constant text[] := ARRAY['id', 'businessId', 'periodId', 'packageId', 'packageVersion', 'packageSha256',
    'recipientVersion', 'approvedAt', 'incompleteAcknowledged', 'openItemCount', 'idempotencyKey',
    'linkPublicId', 'linkTokenHash', 'linkExpiresAt', 'createdAt'];
  k text;
BEGIN
  FOREACH k IN ARRAY frozen LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = format('ACCOUNTANT_DELIVERY_FROZEN: %s cannot change', k);
    END IF;
  END LOOP;
  -- The approver may only disappear (user erasure, FK SET NULL); the recipient snapshot may only be erased.
  IF NEW."approvedByUserId" IS NOT NULL AND NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'ACCOUNTANT_DELIVERY_FROZEN: approvedByUserId cannot change';
  END IF;
  IF (NEW."recipientName" IS NOT NULL AND NEW."recipientName" IS DISTINCT FROM OLD."recipientName")
     OR (NEW."recipientEmail" IS NOT NULL AND NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'ACCOUNTANT_DELIVERY_FROZEN: the recipient snapshot can only be erased';
  END IF;
  -- A revoked link stays revoked.
  IF OLD."linkRevokedAt" IS NOT NULL AND NEW."linkRevokedAt" IS DISTINCT FROM OLD."linkRevokedAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'ACCOUNTANT_DELIVERY_FROZEN: a revoked link cannot be restored';
  END IF;
  IF NEW."downloadCount" < OLD."downloadCount" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'ACCOUNTANT_DELIVERY_FROZEN: the download count only grows';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'APPROVED' AND NEW."status" IN ('SENDING', 'CANCELED'))
    OR (OLD."status" = 'SENDING'  AND NEW."status" IN ('APPROVED', 'ACCEPTED', 'FAILED'))
    OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('DELIVERED', 'BOUNCED', 'FAILED'))
    OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'BOUNCED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = format('ACCOUNTANT_DELIVERY_TRANSITION: %s → %s is refused', OLD."status", NEW."status");
  END IF;
  -- Sending needs a recipient: an erased snapshot can never be sent to.
  IF NEW."status" = 'SENDING' AND NEW."recipientEmail" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'ACCOUNTANT_DELIVERY_ERASED: no recipient to send to';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_delivery_update_guard() FROM PUBLIC;
CREATE TRIGGER "AccountantDelivery_update_guard" BEFORE UPDATE ON "AccountantDelivery"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_delivery_update_guard();

-- ── 9. The trail is append-only ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.accountant_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.accountant_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;  -- a cascade from Business
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only "actorUserId" may change, and only to NULL: the FK action, or the erasure function.
    IF NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId')
       AND (pg_trigger_depth() > 1 OR in_erasure) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZA05',
    MESSAGE = format('ACCOUNTANT_EVENT_APPEND_ONLY: %s on %I is refused; the accountant trail is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_event_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.accountant_event_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = format('ACCOUNTANT_EVENT_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_event_truncate_guard() FROM PUBLIC;

CREATE TRIGGER "AccountantWorkflowEvent_append_only" BEFORE UPDATE OR DELETE ON "AccountantWorkflowEvent"
  FOR EACH ROW EXECUTE FUNCTION public.accountant_event_append_only_guard();
CREATE TRIGGER "AccountantWorkflowEvent_no_truncate" BEFORE TRUNCATE ON "AccountantWorkflowEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.accountant_event_truncate_guard();

-- ── 10. Bootstrap lookups (ids only) ────────────────────────────────────────────────────────────

-- The accountant's link: both the public id AND the hash of the secret must match. Nothing else is
-- returned; the caller reads the delivery under RLS in the business it names.
CREATE OR REPLACE FUNCTION public.accountant_link_resolve(p_public_id text, p_token_hash text)
RETURNS TABLE ("businessId" integer, "deliveryId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT d."businessId", d."id"
    FROM public."AccountantDelivery" d
   WHERE p_public_id ~ '^[A-Za-z0-9_-]{32}$'
     AND p_token_hash ~ '^[0-9a-f]{64}$'
     AND d."linkPublicId" = p_public_id
     AND d."linkTokenHash" = p_token_hash
$fn$;
REVOKE ALL ON FUNCTION public.accountant_link_resolve(text, text) FROM PUBLIC;

-- A provider webhook names the provider's message id; this maps it to the delivery. Ids only.
CREATE OR REPLACE FUNCTION public.accountant_delivery_by_provider_message(p_provider text, p_message_id text)
RETURNS TABLE ("businessId" integer, "deliveryId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT d."businessId", d."id"
    FROM public."AccountantDelivery" d
   WHERE p_provider ~ '^[a-z0-9_-]{1,40}$'
     AND p_message_id ~ '^[A-Za-z0-9_:.-]{1,128}$'
     AND d."provider" = p_provider
     AND d."providerMessageId" = p_message_id
$fn$;
REVOKE ALL ON FUNCTION public.accountant_delivery_by_provider_message(text, text) FROM PUBLIC;

-- ── 11. Account erasure ─────────────────────────────────────────────────────────────────────────
-- Periods and packages are copies of retained fiscal records and stay (LEGAL/FISCAL, like the records
-- themselves). The accountant's personal data goes, written by the erasure adapter in the erased
-- business's tenant transaction: the recipient row (DELETE, policy below), every delivery's recipient
-- snapshot (UPDATE to NULL — the delivery guard allows only that) and every link (revoked).
-- The trail is append-only even for the runtime, so its acting users are nulled here — the one path —
-- and only for the business in the tenant context while that business is being deleted.

CREATE OR REPLACE FUNCTION public.accountant_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA06', MESSAGE = 'ACCOUNTANT_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA06', MESSAGE = 'ACCOUNTANT_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;

  PERFORM set_config('dubiz.accountant_erasure', 'on', true);
  UPDATE "AccountantWorkflowEvent" SET "actorUserId" = NULL
   WHERE "businessId" = v_business AND "actorUserId" IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.accountant_erasure', 'off', true);

  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.accountant_erase_business() FROM PUBLIC;

-- ── 12. Row-level security (FORCE; per command; DELETE only on the recipient, for account erasure) ─

ALTER TABLE "AccountantPeriod" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantPeriod" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_period_tenant_select ON "AccountantPeriod" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_period_tenant_insert ON "AccountantPeriod" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_period_tenant_update ON "AccountantPeriod" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AccountantPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantPackage" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_package_tenant_select ON "AccountantPackage" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_package_tenant_insert ON "AccountantPackage" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_package_tenant_update ON "AccountantPackage" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AccountantRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantRecipient" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_recipient_tenant_select ON "AccountantRecipient" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_recipient_tenant_insert ON "AccountantRecipient" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_recipient_tenant_update ON "AccountantRecipient" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
-- Account erasure removes the accountant's row (CI-AD-13: a runtime DELETE, bound by RLS to the erased
-- business). No route deletes it otherwise.
CREATE POLICY accountant_recipient_runtime_delete ON "AccountantRecipient" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AccountantDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_delivery_tenant_select ON "AccountantDelivery" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_delivery_tenant_insert ON "AccountantDelivery" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_delivery_tenant_update ON "AccountantDelivery" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AccountantWorkflowEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantWorkflowEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_event_tenant_select ON "AccountantWorkflowEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_event_tenant_insert ON "AccountantWorkflowEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 13. Privileges — named explicitly ───────────────────────────────────────────────────────────

REVOKE ALL ON "AccountantPeriod", "AccountantPackage", "AccountantRecipient", "AccountantDelivery", "AccountantWorkflowEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "AccountantPeriod_id_seq", "AccountantPackage_id_seq", "AccountantDelivery_id_seq", "AccountantWorkflowEvent_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the new objects goes first (the Daily
-- Tasks G4 finding: Production's default privileges grant more than a migration names).
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('AccountantPeriod', 'AccountantPackage', 'AccountantRecipient', 'AccountantDelivery', 'AccountantWorkflowEvent',
                         'AccountantPeriod_id_seq', 'AccountantPackage_id_seq', 'AccountantDelivery_id_seq', 'AccountantWorkflowEvent_id_seq')
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
    GRANT SELECT, INSERT, UPDATE ON "AccountantPeriod" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantPeriod_id_seq" TO app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "AccountantPackage" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantPackage_id_seq" TO app_runtime;

    -- DELETE for account erasure only (the adapter; see the policy above).
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AccountantRecipient" TO app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "AccountantDelivery" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantDelivery_id_seq" TO app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "AccountantWorkflowEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantWorkflowEvent_id_seq" TO app_runtime;

    GRANT EXECUTE ON FUNCTION public.accountant_link_resolve(text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.accountant_delivery_by_provider_message(text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.accountant_erase_business() TO app_runtime;
  END IF;
END
$do$;

-- ── 14. The flag — OFF ─────────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('accountant_month_close', 'חבילה חודשית לרואה החשבון', 'documents',
        'הכנה חודשית אוטומטית של חבילת רואה החשבון, התראה, ושליחה לרואה החשבון באישור בעל העסק', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('accountant_month_close', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
