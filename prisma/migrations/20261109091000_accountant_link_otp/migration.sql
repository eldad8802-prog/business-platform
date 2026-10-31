-- Accountant portal — a one-time code on a new device (G5 M5, option C)
--
-- WHAT THIS ADDS
--   "AccountantLinkChallenge"  one code sent to the delivery's own recipient (the address the package was approved
--                              to, snapshot on the delivery — never an address the visitor types): a salted HMAC of
--                              the code (never the code), when it was issued and expires (at most 15 minutes), how many
--                              wrong attempts it had (at most 5) and when it was used (once).
--   "AccountantLinkDevice"     a browser that proved it reads that inbox, FOR THAT DELIVERY ONLY: the HMAC of a random
--                              256-bit cookie value (never the value), until the link expires; revocable. No trust
--                              crosses deliveries, months or packages.
--   Three trail event types:   LINK_CODE_SENT, LINK_CODE_FAILED (wrong / expired / locked / limited / not sent),
--                              LINK_DEVICE_VERIFIED. The payload stays closed (codes only); the trail append-only.
--
-- WHAT IT DOES NOT CHANGE
--   The link itself (public id + secret in the URL fragment, 14 days, revocation) and its lookup function; the owner's
--   revocation and the link's expiry are checked BEFORE any code or device, so neither can bring a dead link back.
--   No role, membership, function or existing policy is touched.
--
-- ISOLATION
--   Both tables: ENABLE + FORCE RLS, per-command policies on app.current_business_id (SELECT, INSERT, UPDATE — no DELETE),
--   composite (businessId, deliveryId) keys to the delivery of the same business, the business FK.
-- PRIVILEGES — named explicitly; the migration role's DEFAULT PRIVILEGES are taken back first
--   app_runtime: SELECT + INSERT; UPDATE of "attempts", "consumedAt" (challenge) and "lastSeenAt", "revokedAt" (device).
--
-- Additive. Rollback: .acct/m5-rollback.sql (owner-run; refuses while either table holds a row or a new event exists).

-- ── 1. AccountantLinkChallenge ─────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantLinkChallenge" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "deliveryId" INTEGER NOT NULL,
  "salt" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "AccountantLinkChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantLinkChallenge_hashes" CHECK ("salt" ~ '^[0-9a-f]{32}$' AND "codeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountantLinkChallenge_lifetime" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '15 minutes'),
  CONSTRAINT "AccountantLinkChallenge_attempts" CHECK ("attempts" BETWEEN 0 AND 5),
  CONSTRAINT "AccountantLinkChallenge_consumed" CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
);
CREATE UNIQUE INDEX "AccountantLinkChallenge_businessId_id_key" ON "AccountantLinkChallenge"("businessId", "id");
CREATE INDEX "AccountantLinkChallenge_delivery_createdAt_idx" ON "AccountantLinkChallenge"("businessId", "deliveryId", "createdAt" DESC);
ALTER TABLE "AccountantLinkChallenge" ADD CONSTRAINT "AccountantLinkChallenge_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantLinkChallenge" ADD CONSTRAINT "AccountantLinkChallenge_delivery_tenant_fkey"
  FOREIGN KEY ("businessId", "deliveryId") REFERENCES "AccountantDelivery"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 2. AccountantLinkDevice ────────────────────────────────────────────────────────────────────

CREATE TABLE "AccountantLinkDevice" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "deliveryId" INTEGER NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AccountantLinkDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantLinkDevice_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  -- At most the link's lifetime (14 days from the approval, a day of slack for the send).
  CONSTRAINT "AccountantLinkDevice_lifetime" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '16 days'),
  CONSTRAINT "AccountantLinkDevice_times" CHECK (("lastSeenAt" IS NULL OR "lastSeenAt" >= "createdAt") AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"))
);
CREATE UNIQUE INDEX "AccountantLinkDevice_businessId_id_key" ON "AccountantLinkDevice"("businessId", "id");
CREATE UNIQUE INDEX "AccountantLinkDevice_tokenHash_key" ON "AccountantLinkDevice"("tokenHash");
CREATE INDEX "AccountantLinkDevice_delivery_idx" ON "AccountantLinkDevice"("businessId", "deliveryId");
ALTER TABLE "AccountantLinkDevice" ADD CONSTRAINT "AccountantLinkDevice_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountantLinkDevice" ADD CONSTRAINT "AccountantLinkDevice_delivery_tenant_fkey"
  FOREIGN KEY ("businessId", "deliveryId") REFERENCES "AccountantDelivery"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 3. Row-level security (FORCE; per command; no DELETE) ──────────────────────────────────────

ALTER TABLE "AccountantLinkChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantLinkChallenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_link_challenge_tenant_select ON "AccountantLinkChallenge" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_link_challenge_tenant_insert ON "AccountantLinkChallenge" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_link_challenge_tenant_update ON "AccountantLinkChallenge" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AccountantLinkDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantLinkDevice" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_link_device_tenant_select ON "AccountantLinkDevice" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_link_device_tenant_insert ON "AccountantLinkDevice" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_link_device_tenant_update ON "AccountantLinkDevice" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 4. The trail's event types (constraint swap; every existing value kept) ────────────────────

ALTER TABLE "AccountantWorkflowEvent"
  DROP CONSTRAINT "AccountantWorkflowEvent_type",
  ADD CONSTRAINT "AccountantWorkflowEvent_type" CHECK ("eventType" IN (
    'PERIOD_EVALUATED', 'PACKAGE_BUILT', 'PACKAGE_BUILD_FAILED', 'PACKAGE_SUPERSEDED', 'PACKAGE_DOWNLOADED_BY_OWNER',
    'ISSUED_PDFS_PREPARED', 'NOTIFIED', 'REMINDED', 'CHANGED_AFTER_SEND',
    'RECIPIENT_SET', 'RECIPIENT_CHANGED',
    'DELIVERY_APPROVED', 'DELIVERY_CANCELED', 'DELIVERY_SENDING', 'DELIVERY_RETRY_SCHEDULED', 'DELIVERY_ACCEPTED',
    'DELIVERY_DELIVERED', 'DELIVERY_BOUNCED', 'DELIVERY_FAILED',
    'LINK_DOWNLOADED', 'LINK_REFUSED', 'LINK_REVOKED',
    'PERIOD_COMPLETED', 'PERIOD_COMPLETED_MANUALLY',
    'LINK_VIEWED', 'LINK_FILE_DOWNLOADED',
    'DELIVERY_COMPLAINED',
    'LINK_CODE_SENT', 'LINK_CODE_FAILED', 'LINK_DEVICE_VERIFIED'));

-- ── 5. Privileges — named explicitly ───────────────────────────────────────────────────────────

REVOKE ALL ON "AccountantLinkChallenge", "AccountantLinkDevice" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "AccountantLinkChallenge_id_seq", "AccountantLinkDevice_id_seq" FROM PUBLIC;

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('AccountantLinkChallenge', 'AccountantLinkDevice', 'AccountantLinkChallenge_id_seq', 'AccountantLinkDevice_id_seq')
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
    GRANT SELECT, INSERT ON "AccountantLinkChallenge" TO app_runtime;
    GRANT UPDATE ("attempts", "consumedAt") ON "AccountantLinkChallenge" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantLinkChallenge_id_seq" TO app_runtime;

    GRANT SELECT, INSERT ON "AccountantLinkDevice" TO app_runtime;
    GRANT UPDATE ("lastSeenAt", "revokedAt") ON "AccountantLinkDevice" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantLinkDevice_id_seq" TO app_runtime;
  END IF;
END
$do$;
