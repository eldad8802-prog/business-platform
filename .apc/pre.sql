-- Rows that exist BEFORE migration 20261230090000 (run as the owner on a lab built by `.apc/lab.sh <db>`, i.e. with
-- the migration pending; `.apc/lab.sh <db> --deploy-only` then applies it): a business with booking settings of its
-- own (MANUAL, no verification — the old defaults), an appointment with a journal event, and a notification with a
-- push delivery, so the battery can show every existing row keeps its values and takes the safe defaults.
-- Synthetic only.
WITH b AS (INSERT INTO "Business" (name, "updatedAt") VALUES ('apc-pre-A', now()) RETURNING id)
INSERT INTO "BookingSettings" ("businessId", "updatedAt") SELECT id, now() FROM b;

INSERT INTO "Appointment" ("businessId", status, "startsAt", "createdByActor", "sourceChannel", "updatedAt")
SELECT id, 'CONFIRMED', now() + interval '1 day', 'SYSTEM', 'PUBLIC_BOOKING', now() FROM "Business" WHERE name = 'apc-pre-A';

INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "payload", "idempotencyKey")
SELECT a."businessId", a.id, 'APPOINTMENT_CREATED', 'SYSTEM', '{"status":"CONFIRMED"}', 'apc-pre-event-0001'
  FROM "Appointment" a JOIN "Business" b ON b.id = a."businessId" WHERE b.name = 'apc-pre-A';

INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
                            "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
SELECT id, 'apc-pre-notification', 'appointments', 'appointments.lab', 'info', 'appointment', 1,
       'תור חדש', '/calendar', ARRAY['IN_APP','PUSH']::"NotificationChannel"[], 'lab', 24, now()
  FROM "Business" WHERE name = 'apc-pre-A';

INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status")
SELECT n."businessId", n.id, 'PUSH', 'PENDING' FROM "Notification" n WHERE n."dedupeKey" = 'apc-pre-notification';
