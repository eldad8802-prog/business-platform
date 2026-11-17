-- Notification engine lab: rows the CURRENT application has already written when the migration is released
-- (run as the owner on the pending lab database, NTE_SEED=.nte/seed.sql). The battery then proves each one
-- survived the migration unchanged and received the documented defaults (provider WEB_PUSH, attempts 0, every
-- new column NULL). Synthetic only.
INSERT INTO "Business" ("name", "updatedAt") VALUES ('nte-seed', now());
INSERT INTO "User" ("email", "password", "businessId", "updatedAt")
  SELECT 'seed@nte.lab', 'x', b."id", now() FROM "Business" b WHERE b."name" = 'nte-seed';

-- app/api/push/subscriptions/route.ts (subscribe) and the account erasure's in-place erase (erased:<id>).
INSERT INTO "PushSubscription" ("businessId", "userId", "endpoint", "p256dh", "auth", "platform", "updatedAt")
  SELECT u."businessId", u."id", 'https://fcm.googleapis.com/fcm/send/seed-web-1', 'BPk_seed', 'au_seed', 'android', now()
    FROM "User" u WHERE u."email" = 'seed@nte.lab';
INSERT INTO "PushSubscription" ("businessId", "userId", "endpoint", "p256dh", "auth", "platform", "updatedAt", "revokedAt")
  SELECT u."businessId", u."id", 'https://updates.push.services.mozilla.com/wpush/v2/seed-2', 'BPk_seed2', 'au_seed2', 'desktop', now(), NULL
    FROM "User" u WHERE u."email" = 'seed@nte.lab';
UPDATE "PushSubscription" SET "endpoint" = 'erased:' || "id", "p256dh" = '', "auth" = '', "revokedAt" = now()
 WHERE "endpoint" = 'https://updates.push.services.mozilla.com/wpush/v2/seed-2';

-- lib/notifications/notification-writer.ts: one notification, IN_APP delivered (SENT) and PUSH owed (PENDING).
INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
                            "title", "summary", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
  SELECT b."id", 'seed:inventory:critical:item:1', 'inventory', 'ACTION_REQUIRED', 'HIGH', 'item', 1,
         'seed', NULL, '/inventory', ARRAY['IN_APP', 'PUSH']::"NotificationChannel"[], 'seed', 24, now()
    FROM "Business" b WHERE b."name" = 'nte-seed';
INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status")
  SELECT n."businessId", n."id", c::"NotificationChannel", s::"NotificationDeliveryStatus"
    FROM "Notification" n, (VALUES ('IN_APP', 'SENT'), ('PUSH', 'PENDING'), ('PUSH', 'SENT'), ('PUSH', 'FAILED')) v(c, s)
   WHERE n."dedupeKey" = 'seed:inventory:critical:item:1';
