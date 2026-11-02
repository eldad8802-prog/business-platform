/**
 * Design direction A — the server changes, proven on the Production-shaped lab (.bkg/lab.sh --with-bkg) through the
 * REAL services AS app_runtime_prod. Run after the lab is built:  npx tsx .appt/redesign-server-battery.ts
 *
 *   S1 the public profile keeps every existing key and only ADDS services[].maxAdvanceDays (the service's own horizon);
 *   S2 a pending request withdrawn by the customer: state CANCELED (unchanged for existing readers) + withdrawn: true,
 *      the request WITHDRAWN, the appointment CANCELED by the CUSTOMER;
 *   S3 an automatically confirmed booking cancelled by the customer: state CANCELED + withdrawn: false, the request stays
 *      APPROVED (unchanged), the appointment CANCELED by the CUSTOMER — and the owner's list carries both facts;
 *   S4 THE NOTICE: what the bell does on a customer's cancellation, decided on the database — the SAME notification row
 *      (one per request, dedupeKey booking-request:<id>) or a new one; read before → unread after?; resolved?; its title
 *      (withdrawn vs cancelled); one more delivery row. The battery REPORTS the behaviour; it changes no policy;
 *   S5 isolation: a token answers only its own business; another business's owner sees none of it;
 *   S6 cancelling again answers as is (idempotent), with the same distinction;
 *   S7 THE FULL NOTICE SEQUENCE: the owner reads the request's notice → the customer cancels → the cancellation notice
 *      is unread → the owner reads it → the booking sweep runs again (also hours later) and the customer cancels again →
 *      the notice stays READ and is not reopened without a new event (the unread count is checked at every step).
 *
 * env: OWNER_URL (lab owner), DATABASE_URL (runtime), AUTH_TOKEN_SECRET. Synthetic only. Exit 1 on any failed check.
 */
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "appt-ui-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";

import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let total = 0;
let failures = 0;
const facts: string[] = [];
function ok(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const config = await import("@/lib/services/appointment/appointment-config.service");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const admin = await import("@/lib/services/booking/booking-admin.service");
  const pub = await import("@/lib/services/booking/public-booking.service");
  const { addCalendarDays, jerusalemDayKey } = await import("@/lib/utils/jerusalem-day");
  const reads = await import("@/lib/notifications/notification-read.service");
  const sweep = await import("@/lib/services/booking/booking-sweep.service");

  const tag = `redesign-${Date.now()}`;
  const mk = async (name: string) => {
    const businessId = (await owner.business.create({ data: { name } })).id;
    const userId = (await owner.user.create({ data: { email: `${tag}-${businessId}@lab.test`, password: "x", businessId } })).id;
    for (const featureKey of ["appointments", "public_booking"]) await owner.businessFeatureAccess.create({ data: { businessId, featureKey, state: "ENABLED", reason: "lab battery" } });
    return { businessId, principal: { kind: "OWNER" as const, businessId, userId } };
  };
  const X = await mk("Studio X — battery");
  const Y = await mk("סטודיו Y — battery");

  const svc = async (businessId: number, name: string) => (await owner.businessService.create({ data: { businessId, name, type: "SERVICE", durationMinutes: 30 } })).id;
  const manual = await svc(X.businessId, "ייעוץ ידני");
  const auto = await svc(X.businessId, "ייעוץ אוטומטי");
  await config.replaceWeeklyRules(X.principal, { rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 20 * 60 })) });
  await config.upsertServicePolicy(X.principal, manual, { publicBookable: true, approvalMode: "MANUAL", maxAdvanceDays: 21 });
  await config.upsertServicePolicy(X.principal, auto, { publicBookable: true, approvalMode: "AUTO", maxAdvanceDays: 30 });
  const settings = await admin.updateBookingSettings(X.principal, { enabled: true, selfCancelEnabled: true, selfCancelWindowHours: 0 });
  const publicId = settings.settings.publicId as string;

  // ── S1 ──
  const profile = await pub.getPublicProfile(publicId) as { business: Record<string, unknown>; staffChoice: string; selfCancel: Record<string, unknown>; services: Array<Record<string, unknown>> };
  ok("S1 the profile keeps its top-level keys", JSON.stringify(Object.keys(profile).sort()) === JSON.stringify(["business", "selfCancel", "services", "staffChoice"]));
  const keys = new Set(profile.services.flatMap((x) => Object.keys(x)));
  ok("S1 every existing service key is still there", ["id", "name", "durationMinutes", "approval"].every((k) => keys.has(k)));
  ok("S1 the only new key is maxAdvanceDays, the service's own horizon", [...keys].filter((k) => !["id", "name", "durationMinutes", "approval", "price", "staff"].includes(k)).join() === "maxAdvanceDays"
    && profile.services.find((x) => x.id === manual)?.maxAdvanceDays === 21 && profile.services.find((x) => x.id === auto)?.maxAdvanceDays === 30);

  const day = addCalendarDays(jerusalemDayKey(new Date()), 2);
  const slot = async (serviceId: number, i: number) => (await pub.getPublicSlots(publicId, { serviceId, fromDay: day, toDay: day })).slots[i].startsAt;
  const submit = (serviceId: number, startsAt: string, name: string, phone: string) =>
    pub.submitPublicRequest(publicId, { serviceId, startsAt, name, phone }, uuidV7(new Date()));

  const pending = await submit(manual, await slot(manual, 0), "Dana Cohen", "050-111-2233");
  const confirmed = await submit(auto, await slot(auto, 4), "נועה לוי", "050-444-5566");
  ok("S2/S3 the two bookings start as PENDING and CONFIRMED", pending.status === "PENDING" && confirmed.status === "CONFIRMED");
  const reqOf = async (name: string) => (await owner.bookingRequest.findFirstOrThrow({ where: { businessId: X.businessId, contactName: name } }));
  const pReq = await reqOf("Dana Cohen");
  const cReq = await reqOf("נועה לוי");

  // ── S4 setup: the owner READS both notices before the customers cancel. ──
  const notice = (requestId: number) => owner.notification.findMany({ where: { businessId: X.businessId, dedupeKey: `booking-request:${requestId}` } });
  const deliveries = async (id: number) => owner.notificationDelivery.count({ where: { businessId: X.businessId, notificationId: id } });
  const [pBefore] = await notice(pReq.id);
  const [cBefore] = await notice(cReq.id);
  ok("S4 before: one notice per request", !!pBefore && !!cBefore);
  // Read through the bell's own path (the route the owner's tap calls).
  const unread0 = await reads.countUnread(X.businessId);
  await reads.markNotificationRead(X.businessId, pBefore.id, new Date());
  await reads.markNotificationRead(X.businessId, cBefore.id, new Date());
  const unread1 = await reads.countUnread(X.businessId);
  ok("S7.1 the owner reads both request notices: the unread count drops by 2", unread1 === unread0 - 2, `${unread0}→${unread1}`);
  const pDeliv = await deliveries(pBefore.id);
  const cDeliv = await deliveries(cBefore.id);

  // ── S2 ──
  const v1 = await pub.viewByToken(pending.manageToken);
  ok("S2 before withdrawing: PENDING, not withdrawn, self-cancel stated", v1.state === "PENDING" && v1.withdrawn === false && v1.selfCancelEnabled === true);
  const w = await pub.cancelByToken(pending.manageToken);
  const pReqAfter = await owner.bookingRequest.findUniqueOrThrow({ where: { id: pReq.id } });
  const pAppt = await owner.appointment.findUniqueOrThrow({ where: { id: pReq.appointmentId } });
  ok("S2 withdrawn: state stays CANCELED for existing readers, withdrawn: true", w.state === "CANCELED" && w.withdrawn === true);
  ok("S2 the request WITHDRAWN, the appointment CANCELED by the customer", pReqAfter.status === "WITHDRAWN" && pAppt.status === "CANCELED" && pAppt.cancelReason === "CUSTOMER_CANCELED");

  // ── S3 ──
  const c = await pub.cancelByToken(confirmed.manageToken);
  const cReqAfter = await owner.bookingRequest.findUniqueOrThrow({ where: { id: cReq.id } });
  const cAppt = await owner.appointment.findUniqueOrThrow({ where: { id: cReq.appointmentId } });
  ok("S3 an approved booking cancelled: CANCELED, withdrawn: false", c.state === "CANCELED" && c.withdrawn === false);
  ok("S3 the request stays APPROVED (unchanged), the appointment CANCELED by the customer", cReqAfter.status === "APPROVED" && cAppt.status === "CANCELED" && cAppt.cancelReason === "CUSTOMER_CANCELED");
  const list = await admin.listBookingRequests(X.principal);
  const row = [...list.pending, ...list.toLink, ...list.recent].find((r) => r.id === cReq.id);
  ok("S3 the owner's list carries both facts (request APPROVED, appointment CANCELED) — the screen reads \"התור בוטל\"", !!row && row.status === "APPROVED" && row.appointment.status === "CANCELED");
  ok("S3 a cancelled booking is not offered for linking to a customer card", !list.toLink.some((r) => r.id === cReq.id));

  // ── S4: what the bell does ──
  for (const [label, reqId, before, deliv, title] of [
    ["withdrawn request", pReq.id, pBefore, pDeliv, "⁨Dana Cohen⁩ משך/ה את הבקשה לתור"],
    ["cancelled booking", cReq.id, cBefore, cDeliv, "⁨נועה לוי⁩ ביטל/ה את התור"],
  ] as const) {
    const rows = await notice(reqId);
    const after = rows[0];
    ok(`S4 ${label}: still ONE notification row for the request (no new row)`, rows.length === 1);
    ok(`S4 ${label}: it is the SAME row as before the cancellation`, after?.id === before.id);
    ok(`S4 ${label}: the title says what happened`, after?.title === title, after?.title ?? "");
    ok(`S4 ${label}: one more IN_APP delivery recorded`, (await deliveries(before.id)) === deliv + 1);
    facts.push(`${label}: row ${before.id} reused; readAt ${before.readAt ? "set" : "null"}→(read by owner)→${after?.readAt === null ? "null (unread again)" : "kept"}; resolvedAt → ${after?.resolvedAt === null ? "null (open)" : "set"}; semanticCategory ${after?.semanticCategory}`);
  }

  // ── S7: after the cancellation notice — read it, run the mechanism again, cancel again ──
  const unread2 = await reads.countUnread(X.businessId);
  ok("S7.2 after the customers' cancellations both notices are unread again (count +2)", unread2 === unread1 + 2, `${unread1}→${unread2}`);
  for (const id of [pBefore.id, cBefore.id]) await reads.markNotificationRead(X.businessId, id, new Date());
  const unread3 = await reads.countUnread(X.businessId);
  ok("S7.3 the owner reads the cancellation notices: count back down by 2", unread3 === unread2 - 2, `${unread2}→${unread3}`);
  const snap = async () => Promise.all([pBefore.id, cBefore.id].map(async (id) => {
    const n = await owner.notification.findUniqueOrThrow({ where: { id } });
    return { id, readAt: n.readAt?.toISOString() ?? null, resolvedAt: n.resolvedAt?.toISOString() ?? null, title: n.title, deliveries: await deliveries(id) };
  }));
  const settled = await snap();
  ok("S7.4 both notices are read now", settled.every((n) => n.readAt !== null));
  const r1 = await sweep.runBookingSweep(new Date());
  const r2 = await sweep.runBookingSweep(new Date(Date.now() + 3 * 3600_000));
  const r3 = await sweep.runBookingSweep(new Date(Date.now() + 13 * 3600_000));
  await pub.cancelByToken(pending.manageToken);
  await pub.cancelByToken(confirmed.manageToken);
  const later = await snap();
  ok("S7.5 the sweep (now, +3h, +13h) and a repeated cancel change nothing: read stays read, no new delivery, same title",
    JSON.stringify(later) === JSON.stringify(settled), JSON.stringify({ settled, later }));
  ok("S7.6 the unread count is unchanged by them", (await reads.countUnread(X.businessId)) === unread3);
  facts.push(`sweeps ran: ${JSON.stringify([r1, r2, r3].map((r) => (r as Record<string, unknown>)))}`);

  // ── S5 isolation ──
  const yList = await admin.listBookingRequests(Y.principal);
  ok("S5 another business's owner sees none of X's requests", [...yList.pending, ...yList.toLink, ...yList.recent].every((r) => r.id !== pReq.id && r.id !== cReq.id));
  let crossRead = "allowed";
  try { await schedule.getAppointment(Y.principal, cReq.appointmentId); } catch (e) { crossRead = (e as { code?: string }).code ?? "refused"; }
  ok("S5 another business cannot read X's appointment", crossRead !== "allowed", crossRead);
  const view = await pub.viewByToken(confirmed.manageToken);
  ok("S5 a token answers only its own business (X's name, nothing of Y)", view.businessName === "Studio X — battery");
  let bad = "allowed";
  try { await pub.viewByToken("A".repeat(43)); } catch (e) { bad = (e as { code?: string }).code ?? "refused"; }
  ok("S5 an unknown token is refused", bad !== "allowed", bad);
  const yNotices = await owner.notification.count({ where: { businessId: Y.businessId, dedupeKey: { in: [`booking-request:${pReq.id}`, `booking-request:${cReq.id}`] } } });
  ok("S5 no notice of X's requests lands in Y", yNotices === 0);

  // ── S6 ──
  const again = await pub.cancelByToken(pending.manageToken);
  ok("S6 cancelling again answers as is, still withdrawn", again.state === "CANCELED" && again.withdrawn === true);
  const again2 = await pub.cancelByToken(confirmed.manageToken);
  ok("S6 …and the cancelled booking still not withdrawn", again2.state === "CANCELED" && again2.withdrawn === false);

  console.log("\nTHE NOTICE, as it behaves today:");
  for (const f of facts) console.log(`  ${f}`);
  console.log(`\n${total - failures} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await owner.$disconnect();
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  });
