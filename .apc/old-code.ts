/**
 * Owner requirement R10 — the PREVIOUS application keeps working on the NEW schema.
 *
 * Runs the Prisma Client generated from main's schema.prisma (before this package: no new models, columns or enum
 * labels) against a lab where migration 20261226090000 is applied, as the runtime role in a tenant transaction, through
 * every model the migration touches: BookingSettings, Appointment, AppointmentEvent, BookingRequest, Notification,
 * NotificationDelivery. Prisma lists columns explicitly, so this is exactly what the deployed code does today.
 *
 * Also measures the one rollback hazard honestly (section 3): rows that only the NEW code writes (a WHATSAPP delivery, a
 * new journal type) are unknown enum labels to the old client — reading them through the old typed client fails. That
 * only matters for a code rollback AFTER the stacked code wrote such rows; it is reported, not hidden.
 *
 * env: OLD_CLIENT (path to the generated old client), OWNER_URL, RUNTIME_URL. Synthetic only.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PrismaClient } = require(process.env.OLD_CLIENT!) as { PrismaClient: any };
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
const notes: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tenant<T>(businessId: number, fn: (tx: any) => Promise<T>): Promise<T | string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return runtime.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${businessId}', true)`);
    return fn(tx);
  }).catch((e: Error) => `ERR ${e.message}`);
}

async function main() {
  const applied = await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261226090000_appointments_completion' AND finished_at IS NOT NULL`);
  ok("0.1 the lab carries the new schema (migration applied)", Number(applied[0].n) === 1);
  const biz = await owner.business.create({ data: { name: "apc-old-code" } });
  const user = await owner.user.create({ data: { email: `old-${Date.now()}@apc.lab`, password: "x", businessId: biz.id } });

  console.log("1. the old client writes and reads every touched model");
  const settings = await tenant(biz.id, (tx) => tx.bookingSettings.create({ data: { businessId: biz.id } }));
  ok("1.1 BookingSettings.create (old column list)", typeof settings !== "string", String(settings));
  ok("1.2 BookingSettings.update + findUnique", typeof await tenant(biz.id, async (tx) => {
    await tx.bookingSettings.update({ where: { businessId: biz.id }, data: { pendingTtlMinutes: 60, showPrices: true } });
    return tx.bookingSettings.findUnique({ where: { businessId: biz.id } });
  }) !== "string");
  const appt = await tenant(biz.id, (tx) => tx.appointment.create({ data: {
    businessId: biz.id, status: "PROPOSED", startsAt: new Date(Date.now() + 86_400_000), durationMinutes: 30,
    endsAt: new Date(Date.now() + 86_400_000 + 1_800_000), createdByActor: "OWNER", createdByUserId: user.id, sourceChannel: "INBOX_WEB", title: "בדיקה" } }));
  ok("1.3 Appointment.create (owner direct create)", typeof appt !== "string", String(appt));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apptId = typeof appt === "string" ? 0 : (appt as any).id;
  ok("1.4 Appointment.update (confirm, version bump) + findMany", typeof await tenant(biz.id, async (tx) => {
    await tx.appointment.update({ where: { id: apptId }, data: { status: "CONFIRMED", version: { increment: 1 } } });
    return tx.appointment.findMany({ where: { businessId: biz.id } });
  }) !== "string");
  ok("1.5 AppointmentEvent.create with an old event type + findMany", typeof await tenant(biz.id, async (tx) => {
    await tx.appointmentEvent.create({ data: { businessId: biz.id, appointmentId: apptId, eventType: "APPOINTMENT_CONFIRMED", actor: "OWNER_USER",
      actorUserId: user.id, payload: { status: "CONFIRMED" }, idempotencyKey: `old-code-${Date.now()}` } });
    return tx.appointmentEvent.findMany({ where: { businessId: biz.id } });
  }) !== "string");
  const appt2 = await tenant(biz.id, (tx) => tx.appointment.create({ data: { businessId: biz.id, status: "PROPOSED", startsAt: new Date(Date.now() + 2 * 86_400_000),
    createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" } }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appt2Id = typeof appt2 === "string" ? 0 : (appt2 as any).id;
  ok("1.6 BookingRequest.create (old public booking path, no phoneVerifiedAt) + findMany", typeof await tenant(biz.id, async (tx) => {
    await tx.bookingRequest.create({ data: { businessId: biz.id, appointmentId: appt2Id, contactName: "לקוח", contactPhone: "972501234567",
      fingerprint: "a".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) } });
    return tx.bookingRequest.findMany({ where: { businessId: biz.id } });
  }) !== "string");
  const notification = await tenant(biz.id, (tx) => tx.notification.create({ data: { businessId: biz.id, dedupeKey: `old-${Date.now()}`, domain: "appointments",
    semanticCategory: "appointments.new", severity: "info", entityType: "appointment", entityId: apptId, title: "תור חדש", href: "/calendar",
    intendedChannels: ["IN_APP", "PUSH"], reason: "lab", cooldownHours: 24 } }));
  ok("1.7 Notification.create (in-app + push)", typeof notification !== "string", String(notification));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nId = typeof notification === "string" ? 0 : (notification as any).id;
  const push = await tenant(biz.id, (tx) => tx.notificationDelivery.create({ data: { businessId: biz.id, notificationId: nId, channel: "PUSH", status: "PENDING", userId: user.id } }));
  ok("1.8 NotificationDelivery.create (an owed push)", typeof push !== "string", String(push));
  ok("1.9 NotificationDelivery.update (the push worker: claim, send, complete) + findMany", typeof await tenant(biz.id, async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (push as any).id;
    await tx.notificationDelivery.update({ where: { id }, data: { leaseUntil: new Date(Date.now() + 60_000), attempts: { increment: 1 } } });
    await tx.notificationDelivery.update({ where: { id }, data: { status: "SENT", completedAt: new Date(), leaseUntil: null } });
    await tx.notificationDelivery.create({ data: { businessId: biz.id, notificationId: nId, channel: "IN_APP", status: "SENT" } });
    return tx.notificationDelivery.findMany({ where: { businessId: biz.id } });
  }) !== "string");
  ok("1.10 the push worker's door still answers", Array.isArray(await runtime.$queryRawUnsafe(`SELECT * FROM public.notification_push_due(now()::timestamp(3), 10)`)));

  console.log("2. what the old code wrote is a valid row of the new schema");
  const rows = await owner.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM "NotificationDelivery" WHERE "businessId" = $1 AND "recipientKind" = 'USER' AND "recipientPhone" IS NULL) AS user_rows,
      (SELECT count(*)::int FROM "Appointment" WHERE "businessId" = $1 AND "seriesId" IS NULL) AS no_series,
      (SELECT count(*)::int FROM "BookingRequest" WHERE "businessId" = $1 AND "phoneVerifiedAt" IS NULL) AS unverified,
      (SELECT "defaultApprovalMode"::text || '/' || "requireVerification"::text FROM "BookingSettings" WHERE "businessId" = $1) AS defaults`, biz.id);
  ok("2.1 deliveries are USER rows without a phone; appointments in no series; the request unverified", rows[0].user_rows === 2 && rows[0].no_series === 2 && rows[0].unverified === 1, JSON.stringify(rows[0]));
  // Prisma sends every schema @default explicitly, so the OLD client keeps writing MANUAL / false: the old code's behaviour is
  // unchanged until the new schema (with @default(AUTO) / @default(true)) ships with the stacked code.
  ok("2.2 a settings row the OLD code creates keeps the old values (MANUAL / no verification) — behaviour unchanged until the new code ships", rows[0].defaults === "MANUAL/false", String(rows[0].defaults));

  console.log("3. rollback hazard, measured (rows only the NEW code writes)");
  await owner.$executeRawUnsafe(`INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "payload", "idempotencyKey")
    VALUES ($1, $2, 'ARRIVED', 'SYSTEM', '{}', $3)`, biz.id, apptId, `old-code-arrived-${Date.now()}`);
  const n2 = await owner.notification.create({ data: { businessId: biz.id, dedupeKey: `old-wa-${Date.now()}`, domain: "appointments", semanticCategory: "appointments.reminder",
    severity: "info", entityType: "appointment", entityId: apptId, title: "x", href: "/calendar", intendedChannels: ["IN_APP"], reason: "lab", cooldownHours: 24 } });
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "recipientKind", "recipientPhone", "templateKey", "messageClass")
    VALUES ($1, $2, 'WHATSAPP', 'PENDING', 'CUSTOMER', '+972501234567', 'appointment_reminder', 'OPERATIONAL')`, biz.id, n2.id);
  const evRead = await tenant(biz.id, (tx) => tx.appointmentEvent.findMany({ where: { businessId: biz.id } }));
  const dRead = await tenant(biz.id, (tx) => tx.notificationDelivery.findMany({ where: { businessId: biz.id } }));
  const dPush = await tenant(biz.id, (tx) => tx.notificationDelivery.findMany({ where: { businessId: biz.id, channel: { in: ["PUSH", "IN_APP"] } } }));
  notes.push(`old client reading ALL journal rows incl. a new type: ${typeof evRead === "string" ? "FAILS (" + evRead.slice(0, 90) + ")" : "ok"}`);
  notes.push(`old client reading ALL deliveries incl. a WHATSAPP row: ${typeof dRead === "string" ? "FAILS (" + dRead.slice(0, 90) + ")" : "ok"}`);
  ok("3.1 the old client's channel-filtered reads (push / in-app — what the old worker and inbox read) still work beside WHATSAPP rows", typeof dPush !== "string", String(dPush));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const n of notes) console.log(`  [NOTE] ${n}`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
