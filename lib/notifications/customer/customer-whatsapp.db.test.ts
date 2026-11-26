/**
 * Customer WhatsApp through the notification engine (G1 / G13 / G14, appointments completion program, workstream F),
 * end to end on a real database AS THE RESTRICTED RUNTIME (app_runtime_prod: NOSUPERUSER NOBYPASSRLS) over every
 * migration including 20261230090000_appointments_completion. The transport is SIMULATED (never a network call: the
 * global fetch throws); the "live" path is exercised only with a FAKE sender.
 *
 *   A. producers     through the REAL appointment service + journal hook: an owner PROPOSED → nothing; confirm →
 *                    "confirmed" + a reminder (notBefore = start − 1440, expiresAt = start); a repeat of the event
 *                    writes nothing; reschedule → "changed", the old reminder superseded, a new one for the new start;
 *                    cancel → "cancelled", every owed message closed; a public request → "received"; no phone → nothing;
 *                    not entitled (public_booking OFF) → nothing; owed rows are never visible in the owner's bell.
 *   B. the lane      simulate: SENT with a sim: id, the template names the business; the reminder waits for its moment;
 *                    a stale reminder (appointment moved under it) is suppressed; quiet hours defer to 08:00; expired
 *                    never sent; retries (fake live sender): transient ×2 then sent — the SAME row (attempts 3, one
 *                    provider id, one row per message); five transients ⇒ retries_exhausted; two lanes racing ⇒ one
 *                    send; live mode mints a fresh manage link (hash stored), simulate mints none.
 *   C. statuses      definer → tenant tx; delivered, then an older 'sent' (ignored), read, repeated read, failed after read
 *                    (ignored); unknown ids ignored; the webhook route's platform branch: statuses applied, NO
 *                    Conversation / Message / IntakeEvent / Customer created; replay of the same body changes nothing.
 *   D. metering      one count per delivery row handed over; retries and status updates never add; simulated apart.
 *   E. verification  sendBookingVerificationCode: SENT, class VERIFICATION, the code stored nowhere; a duplicate
 *                    (same challenge + index) sends nothing; the lane never sends an orphaned one ('not_retryable').
 *   F. isolation     business B's tenant transaction cannot read or change A's deliveries; the definer doors return
 *                    identifiers only.
 *   G. G13 owner     booking notices via notify(): in the bell, no push owed; the reminder owes ONE push, a second sweep
 *                    within two hours owes none; the lock screen is generic even with lockScreenDetails ON.
 *   H. retention     phones older than 30 days on finished rows are erased; a fresh one is kept.
 *   K. isolation     WHATSAPP_PLATFORM_SEND_MODE=off stops customer WhatsApp ONLY: with it on, the owner's booking reminder,
 *                    the owner's own appointment reminder (appointments.upcoming) and a non-appointment category
 *                    (inventory.critical_stock) are still written in-app and PUSHED by the engine's worker to the
 *                    owner's FCM device (fake endpoint), while the customer message stays held.
 *   D2 (A16–A18)     the owner's existing control — BookingSettings.reminderOffsetsMinutes: empty list / no settings ⇒ the
 *                    customers of appointments the business enters get nothing; a public-link booking still gets its answer.
 *   S. item 8        WHATSAPP_PLATFORM_SEND_MODE=off: nothing sent, the same row held ('send_stopped') and sent ONCE after the
 *                    stop is lifted, never past its expiry; the verification API refuses and writes nothing.
 *   L. item 6        a lease running out mid-send ⇒ exactly ONE provider send; an uncertain send is never resent and is
 *                    resolved by the status webhook through the echoed fence (or closed unresolved); a crashed worker's
 *                    attempt is marked uncertain, not resent; too little lease left ⇒ nothing sent.
 * Every appointment write goes through the LOCKED owner API (createAppointment / changeStatus / moveAppointment — I2).
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/notifications/customer/customer-whatsapp.db.test.ts
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

delete process.env.WHATSAPP_PLATFORM_SEND_MODE;
delete process.env.WHATSAPP_PLATFORM_ACCESS_TOKEN;
process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID = "100200300400";
process.env.WHATSAPP_APP_SECRET = "lab-app-secret";
process.env.APP_BASE_URL = "https://app.dubiz.example";
process.env.TASK_REQUEST_HMAC_KEY = "wa-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "wa1";
// A fake FCM project (section K): the engine's push path, end to end, to a fake endpoint — no network.
process.env.FCM_PROJECT_ID = "dubiz-lab";
process.env.FCM_CLIENT_EMAIL = "push@dubiz-lab.iam.gserviceaccount.com";
process.env.FCM_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// No network, ever.
globalThis.fetch = (async () => { throw new Error("NETWORK FORBIDDEN IN TESTS"); }) as typeof fetch;

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 900));
  }
}

async function main() {
  // I2 (integration): every appointment write goes through the LOCKED owner API (appointment-schedule.service:
  // createAppointment / changeStatus / moveAppointment — the business's appointment lock, idempotency keys, the
  // journal). `svc` keeps the battery's call shapes over it.
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const idem = () => ({ idempotencyKey: uuidV7(new Date()) });
  const P = (businessId: number, userId: number) => ({ kind: "OWNER" as const, businessId, userId });
  type Who = { businessId: number; actor: { userId: number } };
  const svc = {
    create: async (i: Who & { links?: { customerId?: number }; details: { startsAt: Date; durationMinutes?: number; title?: string } }) => {
      try {
        const r = await schedule.createAppointment(P(i.businessId, i.actor.userId), idem(), {
          status: "PROPOSED", customerId: i.links?.customerId, startsAt: i.details.startsAt.toISOString(),
          durationMinutes: i.details.durationMinutes ?? 30, ...(i.details.title ? { title: i.details.title } : {}),
        });
        return { ok: true as const, appointment: r.appointment };
      } catch (error) {
        console.log("  create refused", error instanceof Error ? error.message : error);
        return { ok: false as const, appointment: { id: 0 } };
      }
    },
    confirm: (i: Who & { appointmentId: number }) => schedule.changeStatus(P(i.businessId, i.actor.userId), idem(), i.appointmentId, { to: "CONFIRMED" }),
    cancel: (i: Who & { appointmentId: number }) => schedule.changeStatus(P(i.businessId, i.actor.userId), idem(), i.appointmentId, { to: "CANCELED" }),
    reschedule: (i: Who & { appointmentId: number; startsAt: Date; durationMinutes?: number }) =>
      schedule.moveAppointment(P(i.businessId, i.actor.userId), idem(), i.appointmentId, { startsAt: i.startsAt.toISOString(), durationMinutes: i.durationMinutes ?? 30 }),
  };
  const { appendAppointmentEvent } = await import("@/lib/services/appointment/appointment-journal");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { runWhatsAppWorker, WA_LEASE_MS } = await import("./whatsapp-worker");
  const { applyPlatformStatuses } = await import("./whatsapp-status");
  const { monthlyCustomerMessageUsage } = await import("./usage");
  const { sendBookingVerificationCode } = await import("./verification");
  const { purgeCustomerPhones } = await import("./retention");
  const { listNotifications, countUnread } = await import("../notification-read.service");
  const bn = await import("@/lib/services/booking/booking-notify");
  const { getCategory } = await import("../catalog");
  const { buildPushMessage } = await import("../push/push-content");
  const { isQuietHours, quietHoursEnd } = await import("@/lib/services/booking/booking.core");
  const { jerusalemInstantAt, addCalendarDays, jerusalemDayKey } = await import("@/lib/utils/jerusalem-day");
  const route = await import("@/app/api/integrations/whatsapp/webhook/route");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const stamp = Date.now();
  const q = { quiet: true } as const;

  /* ── fixtures (owner) ─────────────────────────────────────────────────────────────────────────────────── */
  for (const key of ["appointments", "public_booking", "notifications_engine"]) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', false, true) ON CONFLICT ("key") DO NOTHING`, key);
  }
  const biz = async (name: string, features: string[]) => {
    const b = await owner.business.create({ data: { name } });
    for (const k of features) {
      await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())`, b.id, k);
    }
    return b.id;
  };
  const A = await biz(`מספרת הלאב ${stamp}`, ["appointments", "public_booking", "notifications_engine"]);
  const B = await biz(`עסק ב ${stamp}`, ["appointments", "public_booking", "notifications_engine"]);
  // The operator kill switch: entitled (appointments + public_booking) but notifications_engine OFF.
  const KILL = await biz(`עסק מושבת ${stamp}`, ["appointments", "public_booking"]);
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'notifications_engine', 'DISABLED', now())`, KILL);
  const userKill = (await owner.user.create({ data: { email: `wa-kill-${stamp}@apc.lab`, password: "x", businessId: KILL } })).id;
  const custKill = (await owner.customer.create({ data: { businessId: KILL, name: "לקוח", phone: "972501112299" } })).id;
  const OFF = await biz(`עסק בסיסי ${stamp}`, ["appointments"]); // no public_booking ⇒ no customer WhatsApp
  const userA = (await owner.user.create({ data: { email: `wa-a-${stamp}@apc.lab`, password: "x", businessId: A } })).id;
  const userOff = (await owner.user.create({ data: { email: `wa-off-${stamp}@apc.lab`, password: "x", businessId: OFF } })).id;
  const custA = (await owner.customer.create({ data: { businessId: A, name: "לקוחה", phone: "972501112233" } })).id;
  const custNoPhone = (await owner.customer.create({ data: { businessId: A, name: "בלי טלפון" } })).id;
  const custOff = (await owner.customer.create({ data: { businessId: OFF, name: "לקוח", phone: "972501112244" } })).id;
  const actor = (userId: number) => ({ actor: "OWNER" as const, userId, sourceChannel: "MOBILE" as const });
  for (const b of [A, B]) await owner.bookingSettings.create({ data: { businessId: b } });
  const D2E = await biz(`עסק בלי תזכורות ${stamp}`, ["appointments", "public_booking", "notifications_engine"]);
  await owner.bookingSettings.create({ data: { businessId: D2E, reminderOffsetsMinutes: [] } });
  const NS = await biz(`עסק בלי הגדרות ${stamp}`, ["appointments", "public_booking", "notifications_engine"]);
  const userD2E = (await owner.user.create({ data: { email: `wa-d2e-${stamp}@apc.lab`, password: "x", businessId: D2E } })).id;
  const userNS = (await owner.user.create({ data: { email: `wa-ns-${stamp}@apc.lab`, password: "x", businessId: NS } })).id;
  const custD2E = (await owner.customer.create({ data: { businessId: D2E, name: "לקוח", phone: "972501112277" } })).id;
  const custNS = (await owner.customer.create({ data: { businessId: NS, name: "לקוח", phone: "972501112288" } })).id;

  // BookingSettings allows only Asia/Jerusalem (CHECK). Deterministic against the wall clock: appointments start at
  // noon (so a day-before reminder is due at noon), and the lane runs at the first moment from now that is outside quiet
  // hours with three hours to spare (the retry ladder). The pending-request message (quiet bypass, 60-min TTL) is sent
  // at the real now.
  const tz = "Asia/Jerusalem";
  const today = jerusalemDayKey(new Date());
  const dayIn = (d: number) => jerusalemInstantAt(addCalendarDays(today, d), 12, 0);
  const start1 = dayIn(4), start2 = dayIn(5);
  let dayNow = new Date();
  while (isQuietHours(dayNow, tz) || isQuietHours(new Date(dayNow.getTime() + 3 * HOUR), tz)) dayNow = new Date(dayNow.getTime() + 30 * MIN);
  ok("A0 the lane moment is outside quiet hours and within the 12-hour TTL of what is created now", !isQuietHours(dayNow, tz) && dayNow.getTime() - Date.now() < 11 * HOUR);

  const deliveries = (businessId: number, appointmentId: number) => owner.notificationDelivery.findMany({
    where: { businessId, appointmentId, recipientKind: "CUSTOMER" },
    select: { id: true, status: true, error: true, nextAttemptAt: true, expiresAt: true, templateKey: true, messageClass: true, providerMessageId: true, attempts: true, recipientPhone: true, notification: { select: { dedupeKey: true, semanticCategory: true, title: true } } },
    orderBy: { id: "asc" },
  });
  const ofCat = (rows: Awaited<ReturnType<typeof deliveries>>, k: string) => rows.filter((r) => r.notification.semanticCategory === `appointments.customer_${k}`);

  /* ── A. producers ───────────────────────────────────────────────────────────────────────────────────── */
  console.log("A. producers (real service + journal hook)");
  const c1 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: start1, durationMinutes: 30, title: "תספורת" } });
  ok("A1 an owner's PROPOSED appointment: nothing owed to the customer", c1.ok && (await deliveries(A, c1.ok ? c1.appointment.id : 0)).length === 0);
  const a1 = c1.ok ? c1.appointment.id : 0;
  await svc.confirm({ appointmentId: a1, businessId: A, actor: actor(userA) });
  let rows = await deliveries(A, a1);
  const conf = ofCat(rows, "confirmed"), rem = ofCat(rows, "reminder");
  ok("A2 confirm ⇒ one 'confirmed' (owed now, no link: the owner's appointment) and one reminder",
    conf.length === 1 && conf[0].status === "PENDING" && conf[0].nextAttemptAt === null && conf[0].templateKey === "dubiz_appt_confirmed_nolink" && conf[0].messageClass === "OPERATIONAL" && conf[0].recipientPhone === "+972501112233" && rem.length === 1, rows);
  ok("A3 reminder: notBefore = start − 24 h, expiresAt = start, key carries the start",
    rem[0]?.nextAttemptAt?.getTime() === start1.getTime() - DAY && rem[0]?.expiresAt?.getTime() === start1.getTime() && rem[0]?.notification.dedupeKey.includes(start1.toISOString()));
  ok("A4 the notification is generic (no name, no phone)", rows.every((r) => r.notification.title === "הודעת WhatsApp ללקוח"));
  await tenantTx(A, (tx) => appendAppointmentEvent(tx, { businessId: A, appointmentId: a1, eventType: "APPOINTMENT_CONFIRMED", ctx: actor(userA), payload: { from: "PROPOSED", to: "CONFIRMED" } }));
  ok("A5 the same event again (a replay): nothing new", (await deliveries(A, a1)).length === rows.length);
  const bellBefore = await countUnread(A);
  const list = await listNotifications(A, { limit: 50, cursor: null, unreadOnly: false });
  ok("A6 the owner's bell never shows a customer message", list.notifications.every((n) => !n.semanticCategory.startsWith("appointments.customer_")) && bellBefore === 0, { bellBefore });

  await svc.reschedule({ appointmentId: a1, businessId: A, actor: actor(userA), startsAt: start2, durationMinutes: 30 });
  rows = await deliveries(A, a1);
  const oldRem = rows.find((r) => r.id === rem[0].id)!;
  const newRem = ofCat(rows, "reminder").filter((r) => r.status === "PENDING");
  ok("A7 moved ⇒ 'changed' owed, the old reminder superseded, ONE new reminder for the new start",
    ofCat(rows, "changed").length === 1 && oldRem.status === "SUPPRESSED" && oldRem.error === "superseded" && newRem.length === 1
      && newRem[0].nextAttemptAt?.getTime() === start2.getTime() - DAY && newRem[0].notification.dedupeKey.includes(start2.toISOString()), rows);
  ok("A8 the 'confirmed' for the OLD start is superseded too (never sent with a wrong time)", rows.find((r) => r.id === conf[0].id)?.status === "SUPPRESSED");
  await svc.reschedule({ appointmentId: a1, businessId: A, actor: actor(userA), startsAt: start1, durationMinutes: 30 });
  rows = await deliveries(A, a1);
  ok("A9 moved back ⇒ the original reminder row is owed again (revived), no second row for the same key",
    rows.find((r) => r.id === rem[0].id)?.status === "PENDING" && ofCat(rows, "reminder").filter((r) => r.notification.dedupeKey === rem[0].notification.dedupeKey).length === 1, rows);

  // A second appointment for the lane, and the public-request path.
  const c2 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(6), durationMinutes: 30, title: "צבע" } });
  const a2 = c2.ok ? c2.appointment.id : 0;
  await svc.confirm({ appointmentId: a2, businessId: A, actor: actor(userA) });
  await svc.cancel({ appointmentId: a2, businessId: A, actor: actor(userA) });
  rows = await deliveries(A, a2);
  ok("A10 cancelled ⇒ 'cancelled' owed; the 'confirmed' and the reminder closed",
    ofCat(rows, "cancelled").length === 1 && ofCat(rows, "cancelled")[0].status === "PENDING"
      && ofCat(rows, "confirmed")[0]?.status === "SUPPRESSED" && ofCat(rows, "reminder").every((r) => r.status === "SUPPRESSED"), rows);

  const pubAppt = await owner.appointment.create({ data: { businessId: A, kind: "CUSTOMER", status: "PROPOSED", startsAt: dayIn(7), endsAt: new Date(dayIn(7).getTime() + 30 * MIN), durationMinutes: 30, title: "תספורת", createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" } });
  await owner.bookingRequest.create({ data: { businessId: A, appointmentId: pubAppt.id, contactName: "מבקשת", contactPhone: "972501112255", fingerprint: createHash("sha256").update(`fp-${stamp}`).digest("hex"), expiresAt: new Date(Date.now() + 12 * HOUR) } });
  await tenantTx(A, (tx) => appendAppointmentEvent(tx, { businessId: A, appointmentId: pubAppt.id, eventType: "APPOINTMENT_CREATED", ctx: { actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" }, payload: { status: "PROPOSED" } }));
  rows = await deliveries(A, pubAppt.id);
  ok("A11 a public request ⇒ 'received' with the manage-link template, the request's phone", ofCat(rows, "received").length === 1 && rows[0].templateKey === "dubiz_appt_received" && rows[0].recipientPhone === "+972501112255", rows);

  const c3 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custNoPhone }, details: { startsAt: dayIn(8), durationMinutes: 30 } });
  if (c3.ok) await svc.confirm({ appointmentId: c3.appointment.id, businessId: A, actor: actor(userA) });
  ok("A12 no phone ⇒ nothing owed", c3.ok && (await deliveries(A, c3.appointment.id)).length === 0);
  const c4 = await svc.create({ businessId: OFF, actor: actor(userOff), links: { customerId: custOff }, details: { startsAt: dayIn(8), durationMinutes: 30 } });
  if (c4.ok) await svc.confirm({ appointmentId: c4.appointment.id, businessId: OFF, actor: actor(userOff) });
  ok("A13 public_booking OFF (Basic) ⇒ no customer WhatsApp at all", c4.ok && (await deliveries(OFF, c4.appointment.id)).length === 0);

  const c4k = await svc.create({ businessId: KILL, actor: actor(userKill), links: { customerId: custKill }, details: { startsAt: dayIn(8), durationMinutes: 30 } });
  if (c4k.ok) await svc.confirm({ appointmentId: c4k.appointment.id, businessId: KILL, actor: actor(userKill) });
  ok("A14 kill switch: notifications_engine OFF (public booking ON) ⇒ nothing owed", c4k.ok && (await deliveries(KILL, c4k.appointment.id)).length === 0);
  const vk = await sendBookingVerificationCode({ businessId: KILL, challengeId: 9100, sendIndex: 1, phone: "0501112299", code: "123456" });
  ok("A15 kill switch: the verification API refuses (not_entitled)", !vk.ok && vk.reason === "not_entitled");

  // D2 — the owner's existing control (BookingSettings.reminderOffsetsMinutes).
  const d2a = await svc.create({ businessId: D2E, actor: actor(userD2E), links: { customerId: custD2E }, details: { startsAt: dayIn(8) } });
  if (d2a.ok) await svc.confirm({ appointmentId: d2a.appointment.id, businessId: D2E, actor: actor(userD2E) });
  ok("A16 D2: reminder times EMPTY ⇒ the customer of an appointment the business entered gets nothing", d2a.ok && (await deliveries(D2E, d2a.appointment.id)).length === 0);
  const d2b = await svc.create({ businessId: NS, actor: actor(userNS), links: { customerId: custNS }, details: { startsAt: dayIn(8) } });
  if (d2b.ok) await svc.confirm({ appointmentId: d2b.appointment.id, businessId: NS, actor: actor(userNS) });
  ok("A17 D2: no booking settings at all ⇒ nothing", d2b.ok && (await deliveries(NS, d2b.appointment.id)).length === 0);
  const d2p = await owner.appointment.create({ data: { businessId: D2E, kind: "CUSTOMER", status: "CONFIRMED", startsAt: dayIn(9), endsAt: new Date(dayIn(9).getTime() + 30 * MIN), durationMinutes: 30, title: "תספורת", createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" } });
  await owner.bookingRequest.create({ data: { businessId: D2E, appointmentId: d2p.id, status: "APPROVED", decidedAt: new Date(), contactName: "מהקישור", contactPhone: "972501112278", fingerprint: createHash("sha256").update(`fp3-${stamp}`).digest("hex"), expiresAt: new Date(Date.now() + 12 * HOUR) } });
  await tenantTx(D2E, (tx) => appendAppointmentEvent(tx, { businessId: D2E, appointmentId: d2p.id, eventType: "APPOINTMENT_CREATED", ctx: { actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" }, payload: { status: "CONFIRMED" } }));
  const d2pRows = await deliveries(D2E, d2p.id);
  ok("A18 D2: a public-link booking still gets its answer ('confirmed') but no reminder (empty list)",
    ofCat(d2pRows, "confirmed").length === 1 && ofCat(d2pRows, "reminder").length === 0, d2pRows);

  /* ── B. the lane ────────────────────────────────────────────────────────────────────────────────────── */
  console.log("B. the WhatsApp lane");
  const recv = (await deliveries(A, pubAppt.id)).map((r) => r.id);
  await runWhatsAppWorker(new Date(), { businessId: A, deliveryIds: recv, ...q });
  let rep = await runWhatsAppWorker(dayNow, { businessId: A, ...q });
  rows = await deliveries(A, a1);
  const sentNow = rows.filter((r) => r.status === "SENT");
  ok("B1 simulate: the due messages are SENT with sim: ids; the reminder is not yet due",
    rep.sent >= 1 && rep.simulated === rep.sent && sentNow.every((r) => /^sim:/.test(r.providerMessageId ?? "") && r.attempts === 1)
      && rows.filter((r) => r.notification.semanticCategory === "appointments.customer_reminder" && r.status === "PENDING").length === 1, { rep, rows });
  const pubRows = await deliveries(A, pubAppt.id);
  ok("B2 the public request's 'received' went out (quiet-hours bypass) with a sim id", pubRows[0].status === "SENT" && /^sim:/.test(pubRows[0].providerMessageId ?? ""));
  ok("B3 simulate never mints a manage token", (await owner.appointmentManageToken.count({ where: { businessId: A, appointmentId: pubAppt.id } })) === 0);
  rep = await runWhatsAppWorker(dayNow, { businessId: A, ...q });
  ok("B4 a second pass sends nothing more", rep.sent === 0);
  const reminderRow = ofCat(await deliveries(A, a1), "reminder").find((r) => r.status === "PENDING")!;
  rep = await runWhatsAppWorker(new Date(start1.getTime() - DAY + MIN), { businessId: A, ...q });
  ok("B5 at its moment the reminder is sent, once", (await owner.notificationDelivery.findUnique({ where: { id: reminderRow.id } }))?.status === "SENT" && rep.sent === 1, rep);

  // Stale: owed for a start the appointment no longer has (the producer's cancel lost a race to the worker's lease).
  const c5 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(9), durationMinutes: 30 } });
  const a5 = c5.ok ? c5.appointment.id : 0;
  await svc.confirm({ appointmentId: a5, businessId: A, actor: actor(userA) });
  await owner.appointment.update({ where: { id: a5 }, data: { startsAt: dayIn(10), endsAt: new Date(dayIn(10).getTime() + 30 * MIN) } }); // behind the producer's back
  rep = await runWhatsAppWorker(dayNow, { businessId: A, ...q });
  ok("B6 a message whose appointment moved under it is suppressed 'stale', never sent", ofCat(await deliveries(A, a5), "confirmed")[0]?.error === "stale", await deliveries(A, a5));

  // Quiet hours and expiry.
  const c6 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(11), durationMinutes: 30 } });
  const a6 = c6.ok ? c6.appointment.id : 0;
  await svc.confirm({ appointmentId: a6, businessId: A, actor: actor(userA) });
  const conf6 = ofCat(await deliveries(A, a6), "confirmed")[0];
  const night = jerusalemInstantAt(addCalendarDays(today, 1), 0, 30);
  await owner.notificationDelivery.update({ where: { id: conf6.id }, data: { expiresAt: new Date(night.getTime() + 12 * HOUR), createdAt: new Date(night.getTime() - MIN) } });
  rep = await runWhatsAppWorker(night, { businessId: A, deliveryIds: [conf6.id], ...q });
  const deferred = await owner.notificationDelivery.findUnique({ where: { id: conf6.id } });
  ok("B7 quiet hours: deferred to 08:00 business time (its own zone), not sent", rep.deferred === 1 && deferred?.status === "PENDING" && deferred.nextAttemptAt?.getTime() === quietHoursEnd(night, tz).getTime(), deferred);
  await owner.notificationDelivery.update({ where: { id: conf6.id }, data: { expiresAt: new Date(night.getTime() + HOUR), nextAttemptAt: null } });
  rep = await runWhatsAppWorker(night, { businessId: A, deliveryIds: [conf6.id], ...q });
  ok("B8 …and when 08:00 is past its expiry: FAILED 'quiet', never sent", (await owner.notificationDelivery.findUnique({ where: { id: conf6.id } }))?.error === "quiet");
  const c7 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(12), durationMinutes: 30 } });
  const a7 = c7.ok ? c7.appointment.id : 0;
  await svc.confirm({ appointmentId: a7, businessId: A, actor: actor(userA) });
  const conf7 = ofCat(await deliveries(A, a7), "confirmed")[0];
  rep = await runWhatsAppWorker(new Date(Date.now() + 13 * HOUR), { businessId: A, deliveryIds: [conf7.id], ...q });
  ok("B9 past its TTL: FAILED 'expired', never sent", (await owner.notificationDelivery.findUnique({ where: { id: conf7.id } }))?.error === "expired" && rep.sent === 0);

  // Retries on the SAME row (fake live sender — no network).
  const liveEnv = { WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "100200300400", WHATSAPP_PLATFORM_ACCESS_TOKEN: "lab-token", APP_BASE_URL: "https://app.dubiz.example" };
  let script: string[] = [];
  const liveSends: { to: string; params: readonly string[]; template: string; callback: string | undefined; button: string | undefined }[] = [];
  let midSend: (() => Promise<void>) | null = null; // runs INSIDE the provider call (a lease running out mid-send)
  const fakeSend = async (i: { toPhone: string; bodyParams: readonly string[]; templateName: string; callbackData?: string; urlButtonParam?: string }) => {
    const next = script.shift() ?? "ok";
    if (next === "transient") return { ok: false as const, kind: "transient" as const, code: "template_429", message: "" };
    if (midSend) { const h = midSend; midSend = null; await h(); }
    liveSends.push({ to: i.toPhone, params: i.bodyParams, template: i.templateName, callback: i.callbackData, button: i.urlButtonParam });
    if (next === "uncertain") return { ok: false as const, kind: "uncertain" as const, code: "template_timeout", message: "" }; // Meta got it, we never heard
    return { ok: true as const, providerMessageId: `wamid.LAB${stamp}${liveSends.length}` };
  };
  const live = { env: liveEnv, send: fakeSend };
  const c8 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(13), durationMinutes: 30, title: "פן" } });
  const a8 = c8.ok ? c8.appointment.id : 0;
  await svc.confirm({ appointmentId: a8, businessId: A, actor: actor(userA) });
  const conf8 = ofCat(await deliveries(A, a8), "confirmed")[0];
  const rowCount0 = await owner.notificationDelivery.count({ where: { businessId: A } });
  script = ["transient", "transient"];
  let t = dayNow;
  await runWhatsAppWorker(t, { businessId: A, deliveryIds: [conf8.id], transport: live, ...q });
  const r1 = await owner.notificationDelivery.findUnique({ where: { id: conf8.id } });
  ok("B10 transient ⇒ same row PENDING, attempts 1, next try in 1 minute", r1?.status === "PENDING" && r1.attempts === 1 && r1.nextAttemptAt?.getTime() === t.getTime() + MIN && r1.providerMessageId === null, r1);
  t = new Date(t.getTime() + MIN);
  await runWhatsAppWorker(t, { businessId: A, deliveryIds: [conf8.id], transport: live, ...q });
  t = new Date(t.getTime() + 5 * MIN);
  await runWhatsAppWorker(t, { businessId: A, deliveryIds: [conf8.id], transport: live, ...q });
  const r3 = await owner.notificationDelivery.findUnique({ where: { id: conf8.id } });
  ok("B11 …then sent: the SAME row, attempts 3, one provider id; no row added by the retries",
    r3?.status === "SENT" && r3.attempts === 3 && /^wamid\.LAB/.test(r3.providerMessageId ?? "") && (await owner.notificationDelivery.count({ where: { businessId: A } })) === rowCount0 && liveSends.length === 1, r3);
  ok("B12 the live message names the business ({{1}}) and carries service, date, time",
    liveSends[0]?.params[0]?.startsWith("מספרת הלאב") && liveSends[0]?.params[1] === "פן" && liveSends[0]?.template === "dubiz_appt_confirmed_nolink" && liveSends[0]?.to === "+972501112233", liveSends);
  await runWhatsAppWorker(new Date(t.getTime() + HOUR), { businessId: A, deliveryIds: [conf8.id], transport: live, ...q });
  ok("B13 a sent row is never sent again", liveSends.length === 1);

  const c9 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(14), durationMinutes: 30 } });
  const a9 = c9.ok ? c9.appointment.id : 0;
  await svc.confirm({ appointmentId: a9, businessId: A, actor: actor(userA) });
  const conf9 = ofCat(await deliveries(A, a9), "confirmed")[0];
  script = Array(10).fill("transient");
  let tt = dayNow;
  for (const step of [0, 1, 5, 15, 60]) {
    tt = new Date(tt.getTime() + step * MIN);
    await runWhatsAppWorker(tt, { businessId: A, deliveryIds: [conf9.id], transport: live, ...q });
  }
  const r9 = await owner.notificationDelivery.findUnique({ where: { id: conf9.id } });
  ok("B14 five transients ⇒ FAILED 'retries_exhausted' (the engine's backoff and maximum)", r9?.status === "FAILED" && r9.error === "retries_exhausted" && r9.attempts === 5, r9);
  script = [];

  const c10 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(15), durationMinutes: 30 } });
  const a10 = c10.ok ? c10.appointment.id : 0;
  await svc.confirm({ appointmentId: a10, businessId: A, actor: actor(userA) });
  const conf10 = ofCat(await deliveries(A, a10), "confirmed")[0];
  const before = liveSends.length;
  await Promise.all([
    runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [conf10.id], transport: live, ...q }),
    runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [conf10.id], transport: live, ...q }),
    runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [conf10.id], transport: live, ...q }),
  ]);
  ok("B15 three lanes racing ⇒ exactly ONE send", liveSends.length === before + 1 && (await owner.notificationDelivery.findUnique({ where: { id: conf10.id } }))?.status === "SENT");

  const pub2 = await owner.appointment.create({ data: { businessId: A, kind: "CUSTOMER", status: "CONFIRMED", startsAt: dayIn(16), endsAt: new Date(dayIn(16).getTime() + 30 * MIN), durationMinutes: 30, title: "תספורת", createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" } });
  await owner.bookingRequest.create({ data: { businessId: A, appointmentId: pub2.id, status: "APPROVED", decidedAt: new Date(), contactName: "אוטומטי", contactPhone: "972501112266", fingerprint: createHash("sha256").update(`fp2-${stamp}`).digest("hex"), expiresAt: new Date(Date.now() + 12 * HOUR) } });
  await tenantTx(A, (tx) => appendAppointmentEvent(tx, { businessId: A, appointmentId: pub2.id, eventType: "APPOINTMENT_CREATED", ctx: { actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" }, payload: { status: "CONFIRMED" } }));
  const confPub = ofCat(await deliveries(A, pub2.id), "confirmed")[0];
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [confPub.id], transport: live, ...q });
  const lastSend = liveSends[liveSends.length - 1];
  const link = lastSend?.button ?? "";
  const { sha256Hex } = await import("@/lib/services/booking/booking.core");
  ok("B16 live: a public booking's message carries a FRESH manage token as the URL BUTTON's parameter (Meta-compliant); only its hash is stored",
    /^[A-Za-z0-9_-]{43}$/.test(link) && lastSend?.params.length === 4 && lastSend?.template === "dubiz_appt_confirmed"
      && (await owner.appointmentManageToken.count({ where: { businessId: A, appointmentId: pub2.id } })) === 1
      && (await owner.appointmentManageToken.findFirst({ where: { appointmentId: pub2.id } }))!.tokenHash === sha256Hex(link), lastSend);

  const c11 = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(17), durationMinutes: 30 } });
  const a11 = c11.ok ? c11.appointment.id : 0;
  await svc.confirm({ appointmentId: a11, businessId: A, actor: actor(userA) });
  const conf11 = ofCat(await deliveries(A, a11), "confirmed")[0];
  await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = now() WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A);
  const sendsBeforeKill = liveSends.length;
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [conf11.id], transport: live, ...q });
  const k11 = await owner.notificationDelivery.findUnique({ where: { id: conf11.id } });
  await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED', "updatedAt" = now() WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A);
  ok("B17 kill switch flipped OFF after a message was owed: the lane sends nothing and closes it not_entitled", k11?.status === "SUPPRESSED" && k11.error === "not_entitled" && liveSends.length === sendsBeforeKill, k11);

  // ── item 8: the WhatsApp emergency stop (WHATSAPP_PLATFORM_SEND_MODE=off) ────────────────────────────────────────
  const newConfirmed = async (d: number) => {
    const c = await svc.create({ businessId: A, actor: actor(userA), links: { customerId: custA }, details: { startsAt: dayIn(d) } });
    await svc.confirm({ appointmentId: c.appointment.id, businessId: A, actor: actor(userA) });
    return ofCat(await deliveries(A, c.appointment.id), "confirmed")[0];
  };
  const offEnv = { env: { ...liveEnv, WHATSAPP_PLATFORM_SEND_MODE: "off" }, send: fakeSend };
  const s1 = await newConfirmed(18);
  const sendsBeforeStop = liveSends.length;
  const rStop = await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [s1.id], transport: offEnv, ...q });
  const sStop = await owner.notificationDelivery.findUnique({ where: { id: s1.id } });
  ok("S1 stop ON: nothing sent; the row is the SAME owed row, held 10 minutes with reason 'send_stopped'",
    rStop.stopped === 1 && liveSends.length === sendsBeforeStop && sStop?.status === "PENDING" && sStop.error === "send_stopped" && sStop.providerMessageId === null
      && sStop.nextAttemptAt?.getTime() === dayNow.getTime() + 10 * MIN, sStop);
  await runWhatsAppWorker(new Date(dayNow.getTime() + 11 * MIN), { businessId: A, deliveryIds: [s1.id], transport: offEnv, ...q });
  ok("S2 still stopped later: still held, still nothing sent", liveSends.length === sendsBeforeStop && (await owner.notificationDelivery.findUnique({ where: { id: s1.id } }))?.status === "PENDING");
  await runWhatsAppWorker(new Date(dayNow.getTime() + 22 * MIN), { businessId: A, deliveryIds: [s1.id], transport: live, ...q });
  await runWhatsAppWorker(new Date(dayNow.getTime() + 40 * MIN), { businessId: A, deliveryIds: [s1.id], transport: live, ...q });
  const sAfter = await owner.notificationDelivery.findUnique({ where: { id: s1.id } });
  ok("S3 stop lifted: the held message goes out ONCE (nothing lost, nothing duplicated)", liveSends.length === sendsBeforeStop + 1 && sAfter?.status === "SENT" && sAfter.error === null, sAfter);
  const vStop = await sendBookingVerificationCode({ businessId: A, challengeId: 9200, sendIndex: 1, phone: "0501112277", code: "123456" }, { transport: offEnv });
  ok("S4 stop ON: the verification API refuses 'send_stopped' and writes nothing",
    !vStop.ok && vStop.reason === "send_stopped" && (await owner.notification.count({ where: { businessId: A, dedupeKey: "wa:verify:c9200:s1" } })) === 0);
  const s5 = await newConfirmed(19);
  await owner.notificationDelivery.update({ where: { id: s5.id }, data: { expiresAt: new Date(dayNow.getTime() + 5 * MIN) } });
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [s5.id], transport: offEnv, ...q });
  const s5a = await owner.notificationDelivery.findUnique({ where: { id: s5.id } });
  await runWhatsAppWorker(new Date(dayNow.getTime() + 6 * MIN), { businessId: A, deliveryIds: [s5.id], transport: offEnv, ...q });
  ok("S5 a held message is never held past its own expiry, then closed 'expired' (stale messages never sent)",
    s5a?.nextAttemptAt?.getTime() === dayNow.getTime() + 5 * MIN && (await owner.notificationDelivery.findUnique({ where: { id: s5.id } }))?.error === "expired");

  // ── item 6: a lease running out MID-SEND never produces a second provider send ─────────────────────────────────────
  const f1 = await newConfirmed(20);
  const before6 = liveSends.length;
  let innerReport: Awaited<ReturnType<typeof runWhatsAppWorker>> | null = null;
  midSend = async () => {
    // While worker 1 is still inside the provider call, its lease runs out and worker 2 claims the same row.
    innerReport = await runWhatsAppWorker(new Date(dayNow.getTime() + 3 * MIN), { businessId: A, deliveryIds: [f1.id], transport: live, ...q });
  };
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [f1.id], transport: live, ...q });
  const f1r = await owner.notificationDelivery.findUnique({ where: { id: f1.id } });
  ok("L1 lease expired mid-send: worker 2 re-claims but does NOT send (marks the attempt uncertain)",
    innerReport !== null && (innerReport as { claimed: number; uncertain: number; sent: number }).claimed === 1 && (innerReport as { uncertain: number }).uncertain === 1 && (innerReport as { sent: number }).sent === 0, innerReport);
  ok("L2 …worker 1's send lands: exactly ONE provider send, the row SENT with Meta's id", liveSends.length === before6 + 1 && f1r?.status === "SENT" && /^wamid\.LAB/.test(f1r.providerMessageId ?? "") && f1r.error === null, f1r);
  for (const t of [20, 40, 120]) await runWhatsAppWorker(new Date(dayNow.getTime() + t * MIN), { businessId: A, deliveryIds: [f1.id], transport: live, ...q });
  ok("L3 later passes never send it again", liveSends.length === before6 + 1);

  const f2 = await newConfirmed(21);
  script = ["uncertain"];
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [f2.id], transport: live, ...q });
  const f2a = await owner.notificationDelivery.findUnique({ where: { id: f2.id } });
  const f2cb = liveSends[liveSends.length - 1].callback ?? "";
  ok("L4 an UNCERTAIN send (Meta got it, we timed out): the row waits 15 min marked uncertain, never resent", f2a?.status === "PENDING" && /^uncertain:/.test(f2a.error ?? "") && f2a.nextAttemptAt?.getTime() === dayNow.getTime() + 15 * MIN, f2a);
  const sendsF2 = liveSends.length;
  await runWhatsAppWorker(new Date(dayNow.getTime() + 5 * MIN), { businessId: A, deliveryIds: [f2.id], transport: live, ...q });
  ok("L5 …not retried while waiting", liveSends.length === sendsF2);
  const resolvedF2 = await applyPlatformStatuses([{ wamid: `wamid.LATE${stamp}`, status: "delivered", timestamp: null, callbackData: f2cb }]);
  const f2b = await owner.notificationDelivery.findUnique({ where: { id: f2.id } });
  ok("L6 the status webhook resolves it by the echoed fence: SENT with Meta's id (and the status), once", resolvedF2.resolved === 1 && f2b?.status === "SENT" && f2b.providerMessageId === `wamid.LATE${stamp}` && f2b.providerStatus === "delivered", { resolvedF2, f2b });
  const again = await applyPlatformStatuses([{ wamid: `wamid.OTHER${stamp}`, status: "read", timestamp: null, callbackData: f2cb }]);
  ok("L7 a second, different id for the same fence changes nothing (write-once)", again.resolved === 0 && (await owner.notificationDelivery.findUnique({ where: { id: f2.id } }))?.providerMessageId === `wamid.LATE${stamp}`);
  await runWhatsAppWorker(new Date(dayNow.getTime() + 20 * MIN), { businessId: A, deliveryIds: [f2.id], transport: live, ...q });
  ok("L8 …and it is never sent again", liveSends.length === sendsF2);

  const f3 = await newConfirmed(22);
  script = ["uncertain"];
  await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [f3.id], transport: live, ...q });
  const f3cb = liveSends[liveSends.length - 1].callback ?? "";
  const sendsF3 = liveSends.length;
  await runWhatsAppWorker(new Date(dayNow.getTime() + 16 * MIN), { businessId: A, deliveryIds: [f3.id], transport: live, ...q });
  const f3a = await owner.notificationDelivery.findUnique({ where: { id: f3.id } });
  ok("L9 uncertain and never resolved: closed FAILED 'unresolved:…' — NOT resent", f3a?.status === "FAILED" && /^unresolved:/.test(f3a.error ?? "") && liveSends.length === sendsF3, f3a);
  await applyPlatformStatuses([{ wamid: `wamid.LATE2${stamp}`, status: "read", timestamp: null, callbackData: f3cb }]);
  ok("L10 a very late webhook still records it SENT (metering exact), still no resend", (await owner.notificationDelivery.findUnique({ where: { id: f3.id } }))?.status === "SENT" && liveSends.length === sendsF3);

  const f4 = await newConfirmed(23);
  await owner.$executeRawUnsafe(`UPDATE "NotificationDelivery" SET "error" = 'inflight:AAAAAAAAAAAAAAAAAAAAAA', "leaseUntil" = $2::timestamp(3) WHERE "id" = $1`, f4.id, new Date(dayNow.getTime() - MIN).toISOString().replace("T", " ").replace("Z", ""));
  const sendsF4 = liveSends.length;
  const r4 = await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [f4.id], transport: live, ...q });
  const f4a = await owner.notificationDelivery.findUnique({ where: { id: f4.id } });
  ok("L11 a crashed worker's attempt (inflight, lease gone): the next claim marks it uncertain, sends nothing", r4.uncertain === 1 && liveSends.length === sendsF4 && f4a?.error === "uncertain:AAAAAAAAAAAAAAAAAAAAAA", f4a);

  const f5 = await newConfirmed(24);
  let tick = 0;
  const lateClock = () => (tick++ === 0 ? 0 : WA_LEASE_MS - 20_000); // the claim, then a clock almost at the lease's end
  const sendsF5 = liveSends.length;
  const r5 = await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [f5.id], transport: live, clock: lateClock, ...q });
  const f5a = await owner.notificationDelivery.findUnique({ where: { id: f5.id } });
  ok("L12 too little lease left to send safely: nothing sent, the row given back as it was (due now, no marker)",
    r5.deferred === 1 && liveSends.length === sendsF5 && f5a?.status === "PENDING" && f5a.error === null && f5a.leaseUntil === null, f5a);
  ok("L13 every provider call carried this row's fence (biz_opaque_callback_data)", liveSends.slice(before6).every((x) => /^dz1:b\d+:d\d+:[A-Za-z0-9_-]{22}$/.test(x.callback ?? "")));

  /* ── C. statuses ────────────────────────────────────────────────────────────────────────────────────── */
  console.log("C. statuses (G14)");
  const wamid = r3!.providerMessageId!;
  const ts = (s: number) => String(Math.floor(Date.now() / 1000) - s);
  const st = (status: string, ago: number, id = wamid) => ({ wamid: id, status, timestamp: ts(ago) });
  const read = () => owner.notificationDelivery.findUnique({ where: { id: conf8.id }, select: { providerStatus: true, providerUpdatedAt: true, status: true } });
  await applyPlatformStatuses([st("delivered", 50)]);
  const d1 = await read();
  await applyPlatformStatuses([st("sent", 60)]);
  ok("C1 delivered, then an OLDER 'sent' arrives: ignored (monotonic)", d1?.providerStatus === "delivered" && (await read())?.providerStatus === "delivered" && (await read())?.providerUpdatedAt?.getTime() === d1?.providerUpdatedAt?.getTime());
  await applyPlatformStatuses([st("read", 40)]);
  const rd = await read();
  await applyPlatformStatuses([st("read", 30), st("read", 30)]);
  ok("C2 read; the same read repeated changes nothing (time kept)", rd?.providerStatus === "read" && (await read())?.providerUpdatedAt?.getTime() === rd?.providerUpdatedAt?.getTime());
  await applyPlatformStatuses([st("failed", 20)]);
  ok("C3 'failed' after read: ignored; the delivery stays SENT", (await read())?.providerStatus === "read" && (await read())?.status === "SENT");
  const unk = await applyPlatformStatuses([st("delivered", 10, "wamid.NOPE"), { wamid: "bad id!", status: "read", timestamp: null }]);
  ok("C4 unknown ids and malformed input ignored", unk.unknown === 1 && unk.invalid === 1 && unk.applied === 0, unk);

  const counts = async () => ({
    conv: await owner.conversation.count(), msg: await owner.message.count(), intake: await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "IntakeEvent"`).then((r) => r[0].n), cust: await owner.customer.count(),
  });
  const c0 = await counts();
  const wamid10 = (await owner.notificationDelivery.findUnique({ where: { id: conf10.id } }))!.providerMessageId!;
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: "100200300400", display_phone_number: "972000000000" },
      statuses: [
        { id: wamid10, status: "read", timestamp: ts(5), recipient_id: "972501112233" },
        { id: wamid10, status: "delivered", timestamp: ts(9), recipient_id: "972501112233" },
      ],
      messages: [{ from: "972501112233", id: `wamid.IN${stamp}`, timestamp: ts(4), type: "text", text: { body: "תודה" } }],
      contacts: [{ wa_id: "972501112233", profile: { name: "לקוחה" } }],
    } }] }],
  });
  const sig = `sha256=${createHmac("sha256", "lab-app-secret").update(body).digest("hex")}`;
  const post = () => route.POST(new Request("https://app.dubiz.example/api/integrations/whatsapp/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sig, "content-type": "application/json" } }) as never);
  const res1 = await post();
  const after1 = await owner.notificationDelivery.findUnique({ where: { id: conf10.id }, select: { providerStatus: true, providerUpdatedAt: true } });
  const res2 = await post();
  const after2 = await owner.notificationDelivery.findUnique({ where: { id: conf10.id }, select: { providerStatus: true, providerUpdatedAt: true } });
  const c1n = await counts();
  ok("C5 the webhook's platform branch: 200, out-of-order (read then older delivered) ⇒ read", res1.status === 200 && after1?.providerStatus === "read", { s: res1.status, after1 });
  ok("C6 replaying the same webhook: 200, nothing changes", res2.status === 200 && after2?.providerUpdatedAt?.getTime() === after1?.providerUpdatedAt?.getTime());
  ok("C7 NO Conversation, Message, IntakeEvent or Customer created (no Inbox pollution)", JSON.stringify(c0) === JSON.stringify(c1n), { c0, c1n });

  /* ── D. metering ────────────────────────────────────────────────────────────────────────────────────── */
  console.log("D. metering");
  const realHanded = await owner.notificationDelivery.count({ where: { businessId: A, recipientKind: "CUSTOMER", providerMessageId: { startsWith: "wamid." } } });
  const usage = await monthlyCustomerMessageUsage(A, new Date());
  ok("D1 one count per message handed over: real (fake-live) messages counted, simulated apart; retries (B10–B14) and statuses (C) never add",
    usage.sent === realHanded && usage.simulated >= 3 && usage.verification === 0, { usage, realHanded });
  ok("D2 the conf8 message (3 attempts, 4 statuses) is counted once", realHanded === liveSends.length, { realHanded, sends: liveSends.length });

  /* ── E. verification ────────────────────────────────────────────────────────────────────────────────── */
  console.log("E. verification (the API workstream G calls)");
  const v1 = await sendBookingVerificationCode({ businessId: A, challengeId: 9001, sendIndex: 1, phone: "0501112277", code: "482915" });
  const vRow = v1.ok ? await owner.notificationDelivery.findUnique({ where: { id: v1.deliveryId }, include: { notification: true } }) : null;
  ok("E1 sent (simulated), class VERIFICATION, template dubiz_booking_code, 5-minute expiry", v1.ok && v1.simulated && vRow?.status === "SENT" && vRow.messageClass === "VERIFICATION" && vRow.templateKey === "dubiz_booking_code"
    && Math.abs((vRow.expiresAt!.getTime() - vRow.createdAt.getTime()) - 5 * MIN) < 2000, vRow);
  ok("E2 the code is stored nowhere", vRow !== null && !JSON.stringify(vRow).includes("482915"));
  const v2 = await sendBookingVerificationCode({ businessId: A, challengeId: 9001, sendIndex: 1, phone: "0501112277", code: "111111" });
  ok("E3 the same (challenge, index) again: duplicate, nothing sent", !v2.ok && v2.reason === "duplicate");
  const v3 = await sendBookingVerificationCode({ businessId: OFF, challengeId: 9002, sendIndex: 1, phone: "0501112277", code: "123456" });
  ok("E4 a business without public_booking: not_entitled", !v3.ok && v3.reason === "not_entitled");
  ok("E5 malformed input refused", !(await sendBookingVerificationCode({ businessId: A, challengeId: 9003, sendIndex: 1, phone: "12", code: "1" })).ok);
  // An orphan (its caller died before sending): the lane never sends it.
  const orphan = await tenantTx(A, async (tx) => (await import("./notify-customer")).notifyCustomer(tx, {
    businessId: A, category: "appointments.customer_verification", entity: { type: "booking_phone_challenge", id: 9004 }, dedupeKey: "wa:verify:c9004:s1",
    recipientPhone: "+972501112277", templateKey: "dubiz_booking_code", appointmentId: null, now: new Date(), expiresAt: new Date(Date.now() + 5 * MIN),
  }));
  await runWhatsAppWorker(new Date(), { businessId: A, ...q });
  ok("E6 an orphaned verification row is closed 'not_retryable' by the lane, never sent", orphan.kind === "created" && (await owner.notificationDelivery.findUnique({ where: { id: orphan.deliveryId } }))?.error === "not_retryable");

  /* ── F. isolation ───────────────────────────────────────────────────────────────────────────────────── */
  console.log("F. isolation");
  const seenFromB = await tenantTx(B, (tx) => tx.notificationDelivery.count({ where: { id: conf8.id } }));
  const changedFromB = await tenantTx(B, (tx) => tx.notificationDelivery.updateMany({ where: { id: conf8.id }, data: { providerStatus: "failed", providerUpdatedAt: new Date() } }));
  ok("F1 B's tenant transaction neither sees nor changes A's delivery", seenFromB === 0 && changedFromB.count === 0);
  const { prisma } = await import("@/lib/prisma");
  const door = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM public.notification_delivery_by_provider_message($1)`, wamid);
  ok("F2 the definer door returns identifiers only", door.length === 1 && Object.keys(door[0]).sort().join() === "businessId,deliveryId");
  const due = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM public.notification_whatsapp_due(now()::timestamp(3), 5)`);
  ok("F3 the due door returns identifiers only", due.every((r) => Object.keys(r).sort().join() === "businessId,deliveryId"));
  const bRun = await runWhatsAppWorker(dayNow, { businessId: B, ...q });
  ok("F4 a worker scoped to B never touches A's rows", bRun.owed === 0);

  /* ── G. G13 owner notices ───────────────────────────────────────────────────────────────────────────── */
  console.log("G. G13 — the owner's booking notices through the engine");
  const facts = { requestId: 777000 + (stamp % 1000), contactName: "ישראל ישראלי", serviceName: "תספורת", when: "א׳ 10:00" };
  const t0 = new Date();
  await tenantTx(A, (tx) => bn.notifyPending(tx, A, facts, t0));
  const note = await owner.notification.findFirstOrThrow({ where: { businessId: A, dedupeKey: `booking-request:${facts.requestId}` }, include: { deliveries: true } });
  ok("G1 a new request: in the bell (category booking.request_waiting), NO push owed", note.semanticCategory === "booking.request_waiting" && note.deliveries.length === 1 && note.deliveries[0].channel === "IN_APP", note.deliveries);
  const owed1 = await tenantTx(A, (tx) => bn.remindPendingRequest(tx, A, facts, 2, new Date(t0.getTime() + 10 * HOUR), new Date(t0.getTime() + 2 * HOUR + MIN)));
  const owed2 = await tenantTx(A, (tx) => bn.remindPendingRequest(tx, A, facts, 2, new Date(t0.getTime() + 10 * HOUR), new Date(t0.getTime() + 2 * HOUR + 2 * MIN)));
  const pushRows = await owner.notificationDelivery.findMany({ where: { notificationId: note.id, channel: "PUSH" } });
  ok("G2 the reminder owes ONE whole-business push (expiring with the request); a racing second sweep owes none",
    owed1 !== null && owed2 === null && pushRows.length === 1 && pushRows[0].status === "PENDING" && pushRows[0].userId === null && pushRows[0].expiresAt?.getTime() === t0.getTime() + 10 * HOUR, { owed1, owed2, pushRows });
  const lock = buildPushMessage(getCategory("booking.request_waiting")!, { id: note.id, title: "בקשה לתור ממתינה 2 שעות: ישראל ישראלי", summary: "x", href: note.href, entityType: note.entityType, entityId: note.entityId }, { lockScreenDetails: true, ttlSeconds: 60 });
  ok("G3 the lock screen is generic even with details ON (no customer name)", !lock.title.includes("ישראל") && !lock.body.includes("ישראל"));
  await tenantTx(A, (tx) => bn.resolveRequestNotification(tx, A, facts.requestId, new Date()));
  ok("G4 resolved when decided", (await owner.notification.findUniqueOrThrow({ where: { id: note.id } })).resolvedAt !== null);

  /* ── H. retention ───────────────────────────────────────────────────────────────────────────────────── */
  console.log("H. retention");
  await owner.notificationDelivery.update({ where: { id: conf8.id }, data: { createdAt: new Date(Date.now() - 31 * DAY) } });
  const erased = await purgeCustomerPhones(new Date());
  ok("H1 a finished message older than 30 days loses its phone; its row, status and provider id stay",
    erased >= 1 && (await owner.notificationDelivery.findUnique({ where: { id: conf8.id } }))?.recipientPhone === null && (await owner.notificationDelivery.findUnique({ where: { id: conf8.id } }))?.providerMessageId === wamid);
  ok("H2 a fresh one keeps its phone", (await owner.notificationDelivery.findUnique({ where: { id: conf10.id } }))?.recipientPhone === "+972501112233");

  /* ── K. the WhatsApp stop never touches any other notification ───────────────────────────────────────── */
  console.log("K. WHATSAPP_PLATFORM_SEND_MODE=off — every other notification unaffected");
  const { runPushWorker } = await import("../engine/push-worker");
  const { notify } = await import("../engine/notify");
  const devices = await import("../engine/devices");
  process.env.WHATSAPP_PLATFORM_SEND_MODE = "off";
  try {
    const fcm: { notificationId: string; category: string }[] = [];
    const fcmFetch = async (url: string, init: { body: string }) => {
      if (url.startsWith("https://oauth2.googleapis.com/")) return { status: 200, text: async () => JSON.stringify({ access_token: "lab-access", expires_in: 3600 }) };
      const m = JSON.parse(init.body).message;
      fcm.push({ notificationId: String(m.data?.notificationId ?? ""), category: String(m.data?.category ?? "") });
      return { status: 200, text: async () => "{}" };
    };
    const u = await owner.user.findUniqueOrThrow({ where: { id: userA }, select: { tokenVersion: true } });
    const sess = await owner.authSession.create({
      data: { userId: userA, secretHash: randomBytes(32).toString("hex"), tokenVersionAtIssue: u.tokenVersion, createdAt: new Date(), lastUsedAt: new Date(), idleExpiresAt: new Date(Date.now() + 30 * DAY), absoluteExpiresAt: new Date(Date.now() + 30 * DAY) },
      select: { id: true },
    });
    await devices.registerFcmDevice({ businessId: A, userId: userA, sessionId: sess.id }, { token: `lab-${userA}:APA91b${randomBytes(24).toString("hex")}`, platform: "android", appVersion: "1.5.0" }, new Date());
    // Lab gap, not product: the appointments-completion lab chain LEDGERS migration 20261213090000 (Production has it
    // applied) without building its NotificationSettings column, which the engine's per-user step reads. Bring this
    // throwaway lab to Production's shape with that migration's own statements (idempotent; a no-op where present).
    await owner.$executeRawUnsafe(`ALTER TABLE "NotificationSettings" ADD COLUMN IF NOT EXISTS "appointmentReminderMinutes" SMALLINT`);
    await owner.$executeRawUnsafe(`DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationSettings_appointment_reminder') THEN
        ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_appointment_reminder"
          CHECK ("appointmentReminderMinutes" IS NULL OR "appointmentReminderMinutes" IN (30, 60, 120, 1440));
      END IF; END $do$`);
    // The owner's own preferences: quiet hours OFF (a fixture — the battery may run at any hour), push ON.
    await owner.notificationSettings.upsert({
      where: { businessId_userId: { businessId: A, userId: userA } },
      create: { businessId: A, userId: userA, pushEnabled: true, quietHoursEnabled: false },
      update: { pushEnabled: true, quietHoursEnabled: false },
    });
    const t0 = new Date();
    const reqId = 880000 + (stamp % 1000);
    const owedBooking = await tenantTx(A, (tx) => bn.remindPendingRequest(tx, A, { requestId: reqId, contactName: "בודק", serviceName: "תספורת", when: "א׳ 10:00" }, 2, new Date(t0.getTime() + 10 * HOUR), t0));
    const upcoming = await tenantTx(A, (tx) => notify(tx, { businessId: A, category: "appointments.upcoming", entity: { type: "appointment", id: 990000 + (stamp % 1000) }, title: "תזכורת לתור", href: "/calendar", userId: userA, now: t0, push: { notBefore: t0, expiresAt: new Date(t0.getTime() + HOUR) } }));
    const inventory = await tenantTx(A, (tx) => notify(tx, { businessId: A, category: "inventory.critical_stock", entity: { type: "inventory_item", id: 770000 + (stamp % 1000) }, title: "מלאי קריטי", href: "/inventory", now: t0 }));
    const waRow = await newConfirmed(25);
    const ids = [owedBooking, upcoming.owedDeliveryId, inventory.owedDeliveryId].filter((x): x is number => typeof x === "number");
    const engineOn = { engineOn: true, categoryAvailable: () => true };
    const past = new Date("2026-01-01T00:00:00Z");
    const pushRep = await runPushWorker(new Date(t0.getTime() + 1000), {
      businessId: A, deps: { fetch: fcmFetch as never }, quiet: true,
      gates: async () => engineOn,
      activation: async () => ({ kind: "on" as const, record: { firstActivatedAt: past, lastActivatedAt: past, priorActivatedAt: past, lastDeactivatedAt: null } }),
    });
    const waRep = await runWhatsAppWorker(dayNow, { businessId: A, deliveryIds: [waRow.id], ...q });
    const inApp = await owner.notificationDelivery.count({ where: { businessId: A, channel: "IN_APP", notificationId: { in: [upcoming.notificationId, inventory.notificationId] } } });
    const bookingNote = await owner.notification.findFirstOrThrow({ where: { businessId: A, dedupeKey: `booking-request:${reqId}` } });
    const sentRows = await owner.notificationDelivery.count({ where: { businessId: A, channel: "PUSH", status: "SENT", subscriptionId: { not: null }, notificationId: { in: [bookingNote.id, upcoming.notificationId, inventory.notificationId] } } });
    const cats = new Set(fcm.map((m) => m.category));
    ok("K1 the stop is ON for this whole section", process.env.WHATSAPP_PLATFORM_SEND_MODE === "off" && ids.length === 3, ids);
    ok("K2 owner in-app: the appointment reminder and the inventory alert are in the bell (and the booking notice)", inApp === 2 && (await owner.notificationDelivery.count({ where: { notificationId: bookingNote.id, channel: "IN_APP" } })) >= 1);
    const k3 = sentRows === 3 && cats.has("booking.request_waiting") && cats.has("appointments.upcoming") && cats.has("inventory.critical_stock") && pushRep.devicesSent === 3;
    if (!k3) {
      // Diagnostics only (the worker swallows per-row errors): surface what this lab refused.
      const probe = async (name: string, f: () => Promise<unknown>) => { try { await f(); console.log(`  probe ${name}: ok`); } catch (e) { console.log(`  probe ${name}: ${e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : e}`); } };
      const { recipientUsers } = await import("../engine/recipients");
      await probe("auth_sessions_live", () => tenantTx(A, (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM public.auth_sessions_live(${[sess.id]}::uuid[], ${new Date().toISOString().replace("T", " ").replace("Z", "")}::timestamp(3))`));
      await probe("recipientUsers", () => tenantTx(A, (tx) => recipientUsers(tx, A, getCategory("inventory.critical_stock")!, null)));
      await probe("devices", () => tenantTx(A, (tx) => tx.pushSubscription.findMany({ where: { businessId: A, userId: userA } })));
      console.log("  rows", JSON.stringify(await owner.notificationDelivery.findMany({ where: { businessId: A, channel: "PUSH", notificationId: { in: [bookingNote.id, upcoming.notificationId, inventory.notificationId] } }, select: { id: true, status: true, error: true, userId: true, subscriptionId: true } })));
    }
    ok("K3 owner PUSH through the engine's worker lane: booking reminder, appointment reminder AND a non-appointment category reach the device",
      k3, { sentRows, cats: [...cats], pushRep });
    const waHeld = await owner.notificationDelivery.findUnique({ where: { id: waRow.id } });
    ok("K4 …while the customer WhatsApp message is HELD (send_stopped), nothing sent", waRep.stopped === 1 && waHeld?.status === "PENDING" && waHeld.error === "send_stopped" && waHeld.providerMessageId === null, waHeld);
  } finally {
    delete process.env.WHATSAPP_PLATFORM_SEND_MODE;
  }

  await owner.$disconnect();
  await prisma.$disconnect();
  console.log(`\n[customer-whatsapp.db] ${checks - failed}/${checks} PASS, FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
