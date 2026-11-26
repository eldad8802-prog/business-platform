/**
 * Appointments health (G4) — the collector and the route on the Production-shaped lab, AS the runtime role.
 *
 * Lab: .bkg/lab.sh <db> --with-bkg, then NTE_ONTO=1 .nte/lab.sh <db> --with-nte (appointments foundation, public
 * booking and the notification engine's definer doors applied by `prisma migrate deploy`).
 * env: OWNER_URL (fixtures, read-back, the fault), DATABASE_URL / DIRECT_URL (app_runtime_prod: NOBYPASSRLS).
 *
 *   A. a clean lab is healthy (200);
 *   B. a lapsed PENDING request and its PROPOSED hold, lapsed > 15 min → booking_sweep_lag + stale_holds; the real
 *      booking sweep then expires them and the check is healthy again;
 *   C. the no-overlap guard removed (owner fault) and two overlapping live appointments in one lane → overlap_guard +
 *      lane_overlaps; restored → healthy;
 *   D. an owed appointments push due 2 h ago → owed_delivery_lag; failures with no send in 24 h → delivery_outage;
 *   E. the route: 401 without the bearer, 500 naming the checks with it; the body holds no business id;
 *   G. channel-agnostic (WhatsApp before F exists): the lab enum gains WHATSAPP (ADD VALUE IF NOT EXISTS — this throwaway
 *      lab only; after F the value already exists) → WhatsApp failures with no WhatsApp send are an outage even while
 *      push sends; an owed WhatsApp delivery is lag — with no code change;
 *   F. read-only: the collector changes no row.
 * Synthetic only. ZERO secrets. ZERO network.
 */
process.env.CRON_SECRET = "appt-health-lab-synthetic-cron-secret-0123456789";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const one = async <T = number>(sql: string, ...p: unknown[]) => Object.values(((await owner.$queryRawUnsafe(sql, ...p)) as Record<string, T>[])[0])[0];
// Prisma writes timestamp(3) columns in UTC; the lab session runs in Asia/Jerusalem, so fixtures say UTC explicitly.
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

async function main() {
  const { collectAppointmentsHealth } = await import("@/lib/services/appointment/appointments-health.service");
  const { evaluateAppointmentsHealth } = await import("@/lib/services/appointment/appointments-health");
  const { runBookingSweep } = await import("@/lib/services/booking/booking-sweep.service");
  const route = await import("@/app/api/appointments/health/route");
  const check = async () => evaluateAppointmentsHealth(await collectAppointmentsHealth(new Date()));

  const bizA = Number(await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('health-A', now()) RETURNING "id"`));
  const bizB = Number(await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('health-B', now()) RETURNING "id"`));
  const userB = Number(await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('health-b@appt.lab', 'x', $1, now()) RETURNING "id"`, bizB));
  const appt = (biz: number, status: string, startMin: number, endMin: number, extra = "NULL") =>
    one(`INSERT INTO "Appointment" ("businessId", "createdByActor", "sourceChannel", "createdByUserId", "kind", "status", "startsAt", "endsAt",
           "durationMinutes", "holdExpiresAt", "updatedAt")
         VALUES ($1, 'OWNER', 'INBOX_WEB', $2, 'CUSTOMER', $3::"AppointmentStatus", ${UTC_NOW} + make_interval(mins => $4::int),
           ${UTC_NOW} + make_interval(mins => $5::int), $5::int - $4::int, ${extra}, now()) RETURNING "id"`, biz, userB, status, startMin, endMin);
  // A live, healthy baseline: a confirmed appointment and a fresh pending request (B).
  await appt(bizB, "CONFIRMED", 24 * 60, 24 * 60 + 30);

  console.log("A. clean lab");
  const a = await check();
  ok("A1 clean lab → healthy", a.ok, JSON.stringify(a));
  ok("A2 every live business visited (A and B among them)", a.counts.businessesScanned >= 2 && a.counts.businessesFailed === 0);
  ok("A3 the guard is present", a.counts.overlapGuardPresent === true);

  console.log("B. a lapsed request and its hold");
  const held = Number(await one(`INSERT INTO "Appointment" ("businessId", "createdByActor", "sourceChannel", "createdByUserId", "kind", "status", "startsAt", "endsAt",
      "durationMinutes", "holdExpiresAt", "updatedAt")
    VALUES ($1, 'CUSTOMER', 'PUBLIC_BOOKING', NULL, 'CUSTOMER', 'PROPOSED', ${UTC_NOW} + interval '2 days', ${UTC_NOW} + interval '2 days 30 minutes', 30,
      ${UTC_NOW} - interval '30 minutes', now()) RETURNING "id"`, bizA));
  await owner.$executeRawUnsafe(`INSERT INTO "BookingRequest" ("businessId", "appointmentId", "contactName", "contactPhone", "fingerprint", "expiresAt", "createdAt", "updatedAt")
    VALUES ($1, $2, 'לקוחה', '972501234567', repeat('a', 64), ${UTC_NOW} - interval '30 minutes', ${UTC_NOW} - interval '12 hours 30 minutes', now())`, bizA, held);
  const b = await check();
  ok("B1 → booking_sweep_lag + stale_holds, one each", b.failing.join(",") === "booking_sweep_lag,stale_holds" && b.counts.staleBookingRequests === 1 && b.counts.staleHolds === 1, JSON.stringify(b));
  const ten = Number(await one(`SELECT count(*)::int FROM "Appointment" WHERE "businessId" = $1 AND "status" = 'PROPOSED'`, bizA));
  const sweep = await runBookingSweep(new Date());
  ok("B2 the real booking sweep expires it", sweep.expired === 1 && sweep.errors === 0 && ten === 1, JSON.stringify(sweep));
  if (sweep.expired !== 1) {
    // Keep the later sections independent of B2: settle the lapsed request the way the sweep would (owner fixture).
    await owner.$executeRawUnsafe(`UPDATE "Appointment" SET "status" = 'CANCELED', "cancelReason" = 'EXPIRED', "holdExpiresAt" = NULL WHERE "id" = $1`, held);
    await owner.$executeRawUnsafe(`UPDATE "BookingRequest" SET "status" = 'EXPIRED', "decidedAt" = ${UTC_NOW} WHERE "appointmentId" = $1`, held);
  }
  const b3 = await check();
  ok("B3 → healthy again, the sweep evidence is fresh", b3.ok && b3.counts.lastSweepEvidenceMinutes === 0, JSON.stringify(b3));

  console.log("C. an overlap, with the guard removed (owner fault)");
  const def = String(await one(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'Appointment_no_overlap'`));
  await owner.$executeRawUnsafe(`ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_no_overlap"`);
  const o1 = Number(await appt(bizB, "CONFIRMED", 60, 120));
  const o2 = Number(await appt(bizB, "PROPOSED", 90, 150));
  const c = await check();
  ok("C1 → overlap_guard + lane_overlaps (one pair)", c.failing.join(",") === "overlap_guard,lane_overlaps" && c.counts.laneOverlaps === 1, JSON.stringify(c));
  await owner.$executeRawUnsafe(`UPDATE "Appointment" SET "status" = 'CANCELED' WHERE "id" = $1`, o2);
  const c2 = await check();
  ok("C2 a cancelled one no longer overlaps (guard still missing)", c2.failing.join(",") === "overlap_guard" && c2.counts.laneOverlaps === 0, JSON.stringify(c2));
  await owner.$executeRawUnsafe(`ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_no_overlap" ${def}`);
  const c3 = await check();
  ok("C3 guard restored → healthy", c3.ok, JSON.stringify(c3));
  void o1;

  console.log("D. owed and failed appointments pushes");
  const notif = Number(await one(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
      "title", "summary", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, 'health:appointments:1', 'appointments', 'ACTION_REQUIRED', 'HIGH', 'booking_request', 1, 'x', NULL, '/calendar',
      ARRAY['IN_APP', 'PUSH']::"NotificationChannel"[], 'lab', 2, now()) RETURNING "id"`, bizA));
  const owed = Number(await one(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "createdAt", "attemptedAt")
    VALUES ($1, $2, 'PUSH', 'PENDING', ${UTC_NOW} - interval '2 hours', ${UTC_NOW} - interval '2 hours') RETURNING "id"`, bizA, notif));
  const d = await check();
  ok("D1 an owed push due 2 h ago → owed_delivery_lag", d.failing.join(",") === "owed_delivery_lag" && (d.counts.oldestOwedDeliveryMinutes ?? 0) >= 119, JSON.stringify(d));
  await owner.$executeRawUnsafe(`UPDATE "NotificationDelivery" SET "nextAttemptAt" = ${UTC_NOW} + interval '1 hour' WHERE "id" = $1`, owed);
  const d2 = await check();
  ok("D2 owed for a LATER moment (a reminder not due yet) is not lag", d2.ok, JSON.stringify(d2));
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "attemptedAt")
    VALUES ($1, $2, 'PUSH', 'FAILED', ${UTC_NOW} - interval '1 hour'), ($1, $2, 'PUSH', 'FAILED', ${UTC_NOW} - interval '2 hours')`, bizA, notif);
  const d3 = await check();
  ok("D3 failures and no send in 24 h → delivery_outage", d3.failing.join(",") === "delivery_outage" && d3.counts.failedDeliveries24h === 2 && d3.counts.sentDeliveries24h === 0, JSON.stringify(d3));

  console.log("E. the route");
  const url = "https://example.test/api/appointments/health";
  const r0 = await route.GET(new NextRequest(url));
  ok("E1 no bearer → 401", r0.status === 401);
  const r1 = await route.GET(new NextRequest(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  const text = await r1.text();
  const body = JSON.parse(text);
  ok("E2 unhealthy → 500 naming the check", r1.status === 500 && body.ok === false && JSON.stringify(body.failing) === '["delivery_outage"]', text);
  const values = Object.values(body.counts as Record<string, unknown>);
  ok("E3 the body holds counts and check names only — no id field, no string value",
    !/"(businessId|appointmentId|requestId|notificationId|id)"/.test(text) && values.every((v) => v === null || typeof v === "number" || typeof v === "boolean"), text);
  ok("E4 no-store", r1.headers.get("cache-control") === "no-store");
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "attemptedAt") VALUES ($1, $2, 'PUSH', 'SENT', ${UTC_NOW})`, bizA, notif);
  const r2 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  ok("E5 one send in 24 h → healthy → 200 (POST, the watchdog's verb)", r2.status === 200, await r2.text());

  console.log("G. channel-agnostic: WhatsApp (as F will add it)");
  await owner.$executeRawUnsafe(`ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP'`);
  // INTEGRATION (#1289 DB / #1291 F): on the completion schema a WhatsApp delivery is a CUSTOMER delivery
  // (CHECK NotificationDelivery_customer_channel); before it, the column does not exist.
  const kindCol = Boolean(await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'NotificationDelivery' AND column_name = 'recipientKind'`));
  const waC = kindCol ? `, "recipientKind", "recipientPhone", "templateKey", "messageClass"` : "";
  const waV = kindCol ? `, 'CUSTOMER', '+972501234567', 'dubiz_appt_reminder', 'OPERATIONAL'` : "";
  // …and at most one customer delivery per notification (NotificationDelivery_customer_one_per_notification_key).
  let waSeq = 0;
  const waNotif = async () => kindCol ? Number(await one(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
      "title", "summary", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, $2, 'appointments', 'ACTION_REQUIRED', 'HIGH', 'booking_request', 1, 'x', NULL, '/calendar',
      ARRAY['WHATSAPP']::"NotificationChannel"[], 'lab', 2, now()) RETURNING "id"`, bizA, `health:appointments:wa:${++waSeq}`)) : notif;
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "attemptedAt"${waC})
    VALUES ($1, $2, 'WHATSAPP', 'FAILED', ${UTC_NOW} - interval '10 minutes'${waV})`, bizA, await waNotif());
  const g1 = await check();
  ok("G1 WhatsApp failed, none sent (push still sends) → delivery_outage, one channel", g1.failing.join(",") === "delivery_outage" && g1.counts.channelsInOutage === 1, JSON.stringify(g1));
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "attemptedAt"${waC}) VALUES ($1, $2, 'WHATSAPP', 'SENT', ${UTC_NOW}${waV})`, bizA, await waNotif());
  const g2 = await check();
  ok("G2 one WhatsApp send → no outage", g2.ok && g2.counts.channelsInOutage === 0, JSON.stringify(g2));
  const wa = Number(await one(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "createdAt", "attemptedAt"${waC})
    VALUES ($1, $2, 'WHATSAPP', 'PENDING', ${UTC_NOW} - interval '45 minutes', ${UTC_NOW} - interval '45 minutes'${waV}) RETURNING "id"`, bizA, await waNotif()));
  const g3 = await check();
  ok("G3 an owed WhatsApp delivery due 45 min ago → owed_delivery_lag", g3.failing.join(",") === "owed_delivery_lag" && (g3.counts.oldestOwedDeliveryMinutes ?? 0) >= 44, JSON.stringify(g3));
  await owner.$executeRawUnsafe(`UPDATE "NotificationDelivery" SET "status" = 'SENT' WHERE "id" = $1`, wa);
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "createdAt", "attemptedAt")
    VALUES ($1, $2, 'IN_APP', 'FAILED', ${UTC_NOW}, ${UTC_NOW}), ($1, $2, 'IN_APP', 'PENDING', ${UTC_NOW} - interval '3 hours', ${UTC_NOW} - interval '3 hours')`, bizA, notif);
  const g4 = await check();
  ok("G4 settled → healthy; IN_APP rows (a failed one, an old pending one) never count", g4.ok, JSON.stringify(g4));

  console.log("F. read-only");
  const fp = `SELECT md5(coalesce((SELECT string_agg(concat_ws('|', id, status, "updatedAt"), ',' ORDER BY id) FROM "Appointment"), '')
                  || coalesce((SELECT string_agg(concat_ws('|', id, status, "updatedAt"), ',' ORDER BY id) FROM "BookingRequest"), '')
                  || coalesce((SELECT string_agg(concat_ws('|', id, status, attempts, "nextAttemptAt", "leaseUntil"), ',' ORDER BY id) FROM "NotificationDelivery"), ''))`;
  const before = await one<string>(fp);
  await collectAppointmentsHealth(new Date());
  ok("F1 the collector changed no row", before === (await one<string>(fp)));
}

main()
  .catch((e) => { failures.push(`crashed: ${e instanceof Error ? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await owner.$disconnect();
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
    process.exit(0);
  });
