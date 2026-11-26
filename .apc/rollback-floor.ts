/**
 * Release item 5 — the rollback FLOOR. Once migration 20261230090000 is applied and the stacked features (E recurring +
 * arrival, F customer WhatsApp, G secure self-service) have written rows of the new kinds, which application code can
 * still read every touched table?
 *
 *   CLIENT=<path>  the Prisma Client under test: this package's own client (the floor — the release that ships this
 *                  schema) or main's client from BEFORE the package (old code).
 *   MODE=floor     every unfiltered read must succeed (exit 1 otherwise);
 *   MODE=report    the reads are listed as ok / FAILS — the evidence for "never roll back below the floor".
 *
 * Seeds (as the owner, raw SQL) exactly the rows E / F / G write: a recurring series and an occurrence in it, journal
 * events of the new types (ARRIVED, SERIES_CREATED, SERIES_CHANGED, STATUS_CORRECTED, CUSTOMER_CHANGED,
 * SERVICE_CHANGED, SELF_RESCHEDULED), a customer WhatsApp delivery (channel WHATSAPP) with provider status, a phone
 * challenge, a verified booking request, settings using the new columns. Then reads every touched model WITHOUT a
 * filter, as the runtime role in the business's tenant transaction — what any list screen, export or worker does.
 *
 * env: CLIENT, MODE, OWNER_URL, RUNTIME_URL. Synthetic only.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PrismaClient } = require(process.env.CLIENT || "@prisma/client") as { PrismaClient: any };
const MODE = process.env.MODE === "report" ? "report" : "floor";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

async function main() {
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  const applied = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS id FROM "_prisma_migrations" WHERE migration_name = '20261230090000_appointments_completion' AND finished_at IS NOT NULL`)) as { id: number }[])[0].id);
  if (applied !== 1) throw new Error("the lab does not carry migration 20261230090000");

  // ── what E / F / G write ─────────────────────────────────────────────────────────────────────
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ('apc-floor', now()) RETURNING id`);
  const user = await one(`INSERT INTO "User" (email, password, "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING id`, `floor-${Date.now()}@apc.lab`, biz);
  const series = await one(`INSERT INTO "AppointmentSeries" ("businessId", frequency, weekday, "startMinute", "durationMinutes", "startsOn", "occurrenceCount", title, "createdByUserId", "updatedAt")
    VALUES ($1, 'WEEKLY', 2, 600, 30, '2026-12-01', 10, 'שבועי', $2, now()) RETURNING id`, biz, user);
  const appt = await one(`INSERT INTO "Appointment" ("businessId", status, "startsAt", "endsAt", "durationMinutes", "createdByActor", "createdByUserId", "sourceChannel", "seriesId", "seriesIndex", "updatedAt")
    VALUES ($1, 'CONFIRMED', '2026-12-01 08:00', '2026-12-01 08:30', 30, 'OWNER', $2, 'INBOX_WEB', $3, 0, now()) RETURNING id`, biz, user, series);
  let k = 0;
  for (const t of ["SERIES_CREATED", "SERIES_CHANGED", "ARRIVED", "STATUS_CORRECTED", "CUSTOMER_CHANGED", "SERVICE_CHANGED", "SELF_RESCHEDULED"]) {
    await owner.$executeRawUnsafe(`INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", actor, payload, "idempotencyKey")
      VALUES ($1, $2, $3::text::"AppointmentEventType", 'SYSTEM', '{"seriesId":1}', $4)`, biz, appt, t, `floor-event-${Date.now()}-${k++}`);
  }
  const notif = await one(`INSERT INTO "Notification" ("businessId", "dedupeKey", domain, "semanticCategory", severity, "entityType", "entityId", title, href, "intendedChannels", reason, "cooldownHours", "updatedAt")
    VALUES ($1, $2, 'appointments', 'appointments.customer_reminder', 'info', 'appointment', $3, 'x', '/calendar', ARRAY['WHATSAPP']::"NotificationChannel"[], 'lab', 0, now()) RETURNING id`, biz, `floor-${Date.now()}`, appt);
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", channel, status, "recipientKind", "recipientPhone", "templateKey", "messageClass",
      "providerMessageId", "providerStatus", "providerUpdatedAt", "appointmentId", "completedAt")
    VALUES ($1, $2, 'WHATSAPP', 'SENT', 'CUSTOMER', '+972501234567', 'appointment_reminder', 'OPERATIONAL', $3, 'delivered', now(), $4, now())`, biz, notif, `sim:floor-${Date.now()}`, appt);
  await owner.$executeRawUnsafe(`INSERT INTO "BookingSettings" ("businessId", "updatedAt", "selfRescheduleEnabled", "reminderOffsetsMinutes", "bookingHorizonDays", "showLogo")
    VALUES ($1, now(), true, '{1440,120}', 90, true)`, biz);
  await owner.$executeRawUnsafe(`INSERT INTO "BookingPhoneChallenge" ("businessId", "phoneHash", "codeHash") VALUES ($1, $2, $3)`, biz, "a".repeat(64), "c".repeat(64));
  const appt2 = await one(`INSERT INTO "Appointment" ("businessId", status, "startsAt", "createdByActor", "sourceChannel", "updatedAt")
    VALUES ($1, 'PROPOSED', '2026-12-02 08:00', 'CUSTOMER', 'PUBLIC_BOOKING', now()) RETURNING id`, biz);
  await owner.$executeRawUnsafe(`INSERT INTO "BookingRequest" ("businessId", "appointmentId", "contactName", "contactPhone", fingerprint, "expiresAt", "phoneVerifiedAt", "updatedAt")
    VALUES ($1, $2, 'לקוח', '972501234567', $3, now() + interval '1 hour', now(), now())`, biz, appt2, "f".repeat(64));

  // ── unfiltered reads, as the runtime in the tenant transaction ───────────────────────────────
  const delegates = ["appointmentEvent", "notificationDelivery", "notification", "appointment", "appointmentSeries", "bookingPhoneChallenge", "bookingSettings", "bookingRequest"];
  const results: [string, string][] = [];
  for (const d of delegates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runtime.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${biz}', true)`);
      if (!tx[d]) return "not in this client (model unknown to it — no read possible)";
      const rows = await tx[d].findMany({ where: { businessId: biz } });
      return `ok (${rows.length} rows)`;
    }).catch((e: Error) => `FAILS — ${String(e.message).split("\n").filter(Boolean).pop()?.slice(0, 140)}`);
    results.push([d, r]);
  }
  for (const [d, r] of results) console.log(`  ${r.startsWith("ok") ? "[OK]  " : r.startsWith("not in") ? "[N/A] " : "[FAIL]"} ${d}.findMany: ${r}`);
  const failed = results.filter(([, r]) => r.startsWith("FAILS")).map(([d]) => d);
  console.log(`\n${MODE}: ${results.length - failed.length} readable, ${failed.length} failing${failed.length ? " (" + failed.join(", ") + ")" : ""}`);
  if (MODE === "floor" && (failed.length || results.some(([, r]) => r.startsWith("not in")))) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
