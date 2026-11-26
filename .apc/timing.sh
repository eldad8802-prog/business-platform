#!/usr/bin/env bash
# Owner requirement R9 — locks, execution time and impact on existing tables, measured on a lab with realistic (and
# larger than Production) row counts.
#
#   .apc/timing.sh <db-name>
#
#   1. Build the pending lab (.apc/lab.sh) and seed: 60 businesses, 120k appointments, 120k journal events, 40k
#      notifications, 300k deliveries, 60 settings rows, 3k booking requests. ANALYZE.
#   2. lock_timeout: a session holds an ordinary read lock on "NotificationDelivery" (an open transaction, as a
#      long-running worker read would); `prisma migrate deploy` must give up after the migration's 5-second
#      lock_timeout, leave NOTHING behind (atomic), and record a failed ledger row that `prisma migrate resolve
#      --rolled-back` clears (the documented recovery). Measured: seconds until it gave up.
#   3. The real release: deploy with nothing in the way. Measured: wall time (= the longest any table is locked:
#      one transaction), and NO table rewrite — the storage file (relfilenode) of every existing table it touches is
#      unchanged.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APC="20261230090000_appointments_completion"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
po() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

bash "$ROOT/.apc/lab.sh" "$DB" >/dev/null

po <<'SQL'
INSERT INTO "Business" (name, "updatedAt") SELECT 'apc-perf-' || g, now() FROM generate_series(1, 60) g;
CREATE TEMP TABLE b AS SELECT id, row_number() OVER (ORDER BY id) AS k FROM "Business" WHERE name LIKE 'apc-perf-%';
INSERT INTO "BookingSettings" ("businessId", "updatedAt") SELECT id, now() FROM b;
INSERT INTO "Appointment" ("businessId", status, "startsAt", "durationMinutes", "createdByActor", "sourceChannel", "updatedAt")
SELECT (SELECT id FROM b WHERE k = 1 + g % 60), (ARRAY['PROPOSED','CONFIRMED','COMPLETED','NO_SHOW','CANCELED'])[1 + g % 5]::"AppointmentStatus",
       now() - interval '200 days' + (g || ' minutes')::interval, 30, 'SYSTEM', 'INBOX_WEB', now()
  FROM generate_series(1, 120000) g;
INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "payload", "idempotencyKey")
SELECT a."businessId", a.id, 'APPOINTMENT_CREATED', 'SYSTEM', '{"status":"PROPOSED"}', 'perf:' || lpad(a.id::text, 10, '0') FROM "Appointment" a
 WHERE a."businessId" IN (SELECT id FROM b);
INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
                            "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
SELECT (SELECT id FROM b WHERE k = 1 + g % 60), 'perf-' || g, 'appointments', 'appointments.lab', 'info', 'appointment', g, 'x', '/calendar',
       ARRAY['IN_APP','PUSH']::"NotificationChannel"[], 'lab', 24, now()
  FROM generate_series(1, 40000) g;
INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "attemptedAt")
SELECT n."businessId", n.id, (ARRAY['IN_APP','PUSH'])[1 + (n.id + s) % 2]::"NotificationChannel",
       (ARRAY['SENT','SENT','FAILED','SUPPRESSED','PENDING'])[1 + (n.id + s) % 5]::"NotificationDeliveryStatus", now() - interval '30 days'
  FROM "Notification" n CROSS JOIN generate_series(1, 8) s
 WHERE n."dedupeKey" LIKE 'perf-%' AND (n.id * 8 + s) % 16 < 15
 LIMIT 300000;
INSERT INTO "BookingRequest" ("businessId", "appointmentId", status, "contactName", "contactPhone", fingerprint, "expiresAt", "decidedAt", "updatedAt")
SELECT a."businessId", a.id, 'APPROVED', 'לקוח', '972500000000', encode(sha256(('perf' || a.id)::bytea), 'hex'), now(), now(), now()
  FROM "Appointment" a WHERE a."businessId" IN (SELECT id FROM b) ORDER BY a.id LIMIT 3000;
ANALYZE "Business", "Appointment", "AppointmentEvent", "Notification", "NotificationDelivery", "BookingSettings", "BookingRequest";
SQL
counts="$(po -At -F" " -c "SELECT (SELECT count(*) FROM \"Business\"), (SELECT count(*) FROM \"Appointment\"), (SELECT count(*) FROM \"AppointmentEvent\"), (SELECT count(*) FROM \"Notification\"), (SELECT count(*) FROM \"NotificationDelivery\"), (SELECT count(*) FROM \"BookingSettings\"), (SELECT count(*) FROM \"BookingRequest\")")"
read -r nb na ne nn nd ns nr <<< "$counts"
counts="$nb businesses, $na appointments, $ne events, $nn notifications, $nd deliveries, $ns settings, $nr requests"
echo "TIMING rows: $counts"

# ── 2. lock_timeout ──
# The holder keeps its read lock until it is terminated below (the Prisma CLI alone can take minutes to start here).
PGAPPNAME=apc-lock-holder PGOPTIONS="-c client_min_messages=warning" psql -X -q "$OWNER_URL" -c 'BEGIN; SELECT count(*) FROM "NotificationDelivery" WHERE id < 10; SELECT pg_sleep(1800); COMMIT;' >/dev/null 2>&1 &
HOLDER=$!
sleep 3
t0=$(now_ms)
set +e
out="$(bash "$ROOT/.apc/lab.sh" "$DB" --deploy-only 2>&1)"
rc=$?
set -e
t1=$(now_ms)
echo "$out" | grep -iE "lock timeout|canceling statement|Error" | head -3 || true
release_holder() { po -At -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = 'apc-lock-holder'" >/dev/null || true; wait $HOLDER 2>/dev/null || true; }
held="$(po -At -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'apc-lock-holder' AND state <> 'idle'")"
echo "TIMING lock holder still holding when deploy returned: $held"
[ $rc -ne 0 ] || { echo "deploy did NOT give up behind a held lock"; release_holder; exit 1; }
echo "$out" | grep -qi "lock timeout" || { echo "$out"; echo "deploy failed, but not on the lock timeout"; release_holder; exit 1; }
left="$(po -At -c "SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('AppointmentSeries','BookingPhoneChallenge'))
  + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'NotificationDelivery' AND column_name = 'recipientKind')
  + (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE (t.typname = 'NotificationChannel' AND e.enumlabel = 'WHATSAPP') OR (t.typname = 'AppointmentEventType' AND e.enumlabel = 'ARRIVED'))")"
failed="$(po -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$APC' AND finished_at IS NULL AND rolled_back_at IS NULL")"
echo "TIMING lock_timeout: gave up after $(( (t1 - t0) / 1000 ))s behind a held read lock; objects left behind: $left; failed ledger rows: $failed"
[ "$left" = "0" ] || { echo "NOT atomic behind the lock"; release_holder; exit 1; }
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate resolve --rolled-back "$APC" >/dev/null )
echo "TIMING recovery: prisma migrate resolve --rolled-back cleared the failed row"
release_holder

# ── 3. the release with nothing in the way ──
t0=$(now_ms)
bash "$ROOT/.apc/lab.sh" "$DB" --deploy-only | grep -E "Applying|applied|Error" || true
t1=$(now_ms)
rewritten="$(po -At -c "SELECT count(*) FROM \"_apc_lab_snapshot\" s JOIN pg_class c ON c.relname = s.relname AND c.relnamespace = 'public'::regnamespace WHERE c.relfilenode <> s.filenode")"
applied="$(po -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$APC' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")"
inside="$(po -At -c "SELECT round(extract(epoch FROM (finished_at - started_at)) * 1000) FROM \"_prisma_migrations\" WHERE migration_name = '$APC' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")"
echo "TIMING migration transaction (ledger started_at → finished_at): ${inside} ms"
echo "TIMING release: prisma migrate deploy took $(( t1 - t0 )) ms end to end (one transaction; includes the Prisma CLI start); applied rows: $applied; tables rewritten: $rewritten of 6"
[ "$applied" = "1" ] && [ "$rewritten" = "0" ] || { echo "release check failed"; exit 1; }
echo "TIMING OK"
