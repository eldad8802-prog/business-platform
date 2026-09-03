-- Notification persistence — the memory layer for the notification system.
--
-- WHY
--
-- `lib/business-status` recomputes a fresh snapshot on every read. That makes it
-- a good answer to "what needs attention right now" and a structurally
-- impossible answer to "have we already told them?". These two tables are that
-- memory. `lib/notifications/notification-policy.ts` decides WHAT deserves to
-- reach the owner; this schema stores the decision and what came of it.
--
-- CAPABILITY ONLY. Nothing reads or writes these tables yet: no service, no
-- route, no UI. Applying this migration changes no behaviour. Adding a NEW model
-- also alters no existing query — Prisma emits a per-model column list, so no
-- current SELECT gains a column. That is the opposite of a new column on an
-- EXISTING model, which is what took Production down on 2026-09-02.
--
-- EXPAND-ONLY: two new tables, two new enums. No ALTER on any existing table, no
-- backfill, no destructive statement. The only lock touching existing data is
-- the brief one Postgres takes on "Business" to add the two foreign keys.
--
-- Deliberately NOT idempotent, with no exceptions: every statement below —
-- CREATE TYPE included — fails if the object already exists. Prisma's ledger
-- already guarantees a migration runs once, so a guard would only convert
-- unexpected schema drift into silence. Failing loudly is the safer outcome.
--
-- The DDL body is exactly what `prisma migrate diff` emits for this schema
-- delta; only the row-level security block below it is hand-written.
--
-- Executed end to end against a disposable local PostgreSQL 17 (UTF8), from the
-- true pre-migration baseline of origin/main: 41 assertions, 0 failures,
-- including the cross-tenant rejection and the RLS behaviour under a restricted
-- non-owner role.

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH');
-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');
-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "semanticCategory" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "href" TEXT NOT NULL,
    "intendedChannels" "NotificationChannel"[],
    "reason" TEXT NOT NULL,
    "cooldownHours" INTEGER NOT NULL,
    "firstSurfacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSurfacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "Notification_businessId_readAt_idx" ON "Notification"("businessId", "readAt");
-- CreateIndex
CREATE INDEX "Notification_businessId_lastSurfacedAt_idx" ON "Notification"("businessId", "lastSurfacedAt");
-- CreateIndex
CREATE UNIQUE INDEX "Notification_businessId_dedupeKey_key" ON "Notification"("businessId", "dedupeKey");
-- CreateIndex
CREATE UNIQUE INDEX "Notification_id_businessId_key" ON "Notification"("id", "businessId");
-- CreateIndex
CREATE INDEX "NotificationDelivery_businessId_notificationId_attemptedAt_idx" ON "NotificationDelivery"("businessId", "notificationId", "attemptedAt");
-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_businessId_fkey" FOREIGN KEY ("notificationId", "businessId") REFERENCES "Notification"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- Both tables are tenant-owned business data, so they take the tenant-data shape
-- used by every P7 wave (not the control-plane shape): ENABLE + FORCE + a single
-- policy on the transaction-local GUC.
--
-- Fail-closed by construction: with no GUC set, current_setting(..., true)
-- returns '', NULLIF yields NULL, and the comparison is NULL — so no row
-- qualifies. INERT under an owner/BYPASSRLS runtime (Production today);
-- enforcing under a least-privilege runtime role.
--
-- NotificationDelivery carries its own "businessId" and gets its own policy
-- rather than inheriting ownership through the foreign key. Deriving it would
-- leave the child unprotected — the same reasoning AD-2A applied to Message.

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;

CREATE POLICY notif_tenant ON "Notification"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "NotificationDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDelivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY notif_delivery_tenant ON "NotificationDelivery"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
