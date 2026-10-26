/**
 * Appointments milestone A — the APPLICATION, end to end, on the Production-shaped lab (.appt/lab.sh --with-appt):
 * tenant plane DATABASE_URL = app_runtime_prod (NOSUPERUSER NOBYPASSRLS), owner (OWNER_URL) for fixtures and read-back.
 * The real route handlers are called with real signed session tokens; nothing is mocked but the clock where stated.
 *
 *   A. The flag: OFF → every new route 404 for a signed-in owner, 401 without a session; the routes that predate
 *      milestone A keep working with the flag off. ON for one business only.
 *   B. Configuration: staff without login, weekly hours, an exception, a service policy, staff ↔ services.
 *   C. Create: 201; same key + same body → replayed (200, one row); same key + another body → 409; an overlap → 409
 *      SLOT_CONFLICT naming the conflict; outside the hours → created with a warning; a block; refusals by input.
 *   D. Concurrency through the service: twelve simultaneous bookings of one slot → exactly one, eleven SLOT_CONFLICT,
 *      no 500; the database holds one.
 *   E. Move: into a conflict → 409; a stale version → 409; a real move → journalled + the learning sensor (customer
 *      appointments only).
 *   F. Status: the single lifecycle, cancel frees the time, a block only cancels, sensors for customer appointments
 *      only, every change journalled with the owner as the actor.
 *   G. Reads and isolation: the range, a staff lane, the other business sees nothing and gets 404 for a foreign id.
 *   H. Free slots respect hours, the exception, buffers and busy time.
 *   I. The paths that predate milestone A: create without a time, conversion of a conversation's pending request,
 *      the old reschedule and the old POST route — unchanged, now journalled; a timed row refused by the old reschedule.
 *   J. Learning: the appointment evidence loader reads customer appointments only.
 *   K. Decision 6: a CUSTOMER or SYSTEM action carries no user anywhere; an OWNER action always does.
 *   L. A failed journal write (lab fault trigger) undoes the whole change on the paths that predate milestone A:
 *      500, the appointment untouched, no event, no sensor, no half conversion; without the fault the same call works.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 */
process.env.AUTH_TOKEN_SECRET = "appt-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = "appt-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "lab1";
// Sessions are resolved on the auth plane (its own connection, AUTH_DATABASE_URL), as in Production; the lab points
// it at the owner. Every appointment read and write still runs as app_runtime_prod (DATABASE_URL).
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const n = async (sql: string) => Number(((await owner.$queryRawUnsafe(sql)) as { n: number }[])[0].n);

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const legacy = await import("@/lib/services/appointment/appointment.service");
  const { loadAppointments } = await import("@/lib/knowledge/evidence/sources");
  const routes = {
    root: await import("@/app/api/appointments/route"),
    one: await import("@/app/api/appointments/[id]/route"),
    reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
    status: await import("@/app/api/appointments/[id]/status/route"),
    details: await import("@/app/api/appointments/[id]/details/route"),
    slots: await import("@/app/api/appointments/slots/route"),
    staff: await import("@/app/api/appointments/staff/route"),
    staffOne: await import("@/app/api/appointments/staff/[staffId]/route"),
    staffServices: await import("@/app/api/appointments/staff/[staffId]/services/route"),
    availability: await import("@/app/api/appointments/availability/route"),
    exceptions: await import("@/app/api/appointments/availability/exceptions/route"),
    policy: await import("@/app/api/appointments/services/[serviceId]/policy/route"),
  };

  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const tag = `appt-app-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: `${tag}-A` } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  const svcA = (await owner.businessService.create({ data: { businessId: bizA, name: "תספורת", type: "SERVICE", durationMinutes: 60 } })).id;
  const svcA2 = (await owner.businessService.create({ data: { businessId: bizA, name: "צבע", type: "SERVICE", durationMinutes: 90 } })).id;
  const svcB = (await owner.businessService.create({ data: { businessId: bizB, name: "עיסוי", type: "SERVICE", durationMinutes: 45 } })).id;
  const custA = (await owner.customer.create({ data: { businessId: bizA, name: "לקוחה א" } })).id;
  const custB = (await owner.customer.create({ data: { businessId: bizB, name: "לקוחה ב" } })).id;
  const tokenA = signAuthToken(userA, 0);
  const tokenB = signAuthToken(userB, 0);

  const BASE = "https://app.example.com";
  type Init = { method?: string; body?: unknown; key?: string | null; token?: string | null };
  const req = (path: string, init: Init = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = init.token === undefined ? tokenA : init.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
  const body = async (r: Response) => { try { return await r.json(); } catch { return null; } };
  const key = () => uuidV7(new Date());

  // A Sunday-to-Wednesday week 21–27 days ahead (inside every horizon, never in the past), in Israel time.
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { weekdayOf } = await import("@/lib/services/appointment/availability.core");
  let SUN = addCalendarDays(jerusalemDayKey(new Date()), 21);
  while (weekdayOf(SUN) !== 0) SUN = addCalendarDays(SUN, 1);
  const MON = addCalendarDays(SUN, 1);
  const TUE = addCalendarDays(SUN, 2);
  const WED = addCalendarDays(SUN, 3);
  const at = (hhmm: string, day = SUN) => {
    const [h, m] = hhmm.split(":").map(Number);
    return jerusalemInstantAt(day, h, m).toISOString();
  };
  console.log(`  (the week of ${SUN})`);

  // ── A. The flag ────────────────────────────────────────────────────────────────────────────────
  console.log("A. the flag");
  let r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:00")}`));
  ok("A1 flag OFF: the signed-in owner gets 404 (the route does not exist for the business)", r.status === 404, String(r.status));
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:00")}`, { token: null }));
  ok("A2 no session → 401", r.status === 401, String(r.status));
  r = await routes.staff.POST(req("/api/appointments/staff", { method: "POST", body: { displayName: "x" } }));
  ok("A3 flag OFF: a write route is 404 too, and wrote nothing", r.status === 404 && (await n(`SELECT count(*)::int AS n FROM "StaffMember" WHERE "businessId" = ${bizA}`)) === 0);
  const pre = await legacy.create({ businessId: bizA, actor: { actor: "OWNER", userId: userA, sourceChannel: "INBOX_WEB" } });
  r = pre.ok ? await routes.one.POST(req(`/api/appointments/${pre.appointment.id}`, { method: "POST", body: { action: "confirm" } }), p({ id: String(pre.appointment.id) })) : new Response(null, { status: 599 });
  ok("A4 flag OFF: the route that predates milestone A still confirms", r.status === 200 && (await body(r))?.appointment?.status === "CONFIRMED", String(r.status));
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:00")}`));
  ok("A5 flag ON for business A → 200", r.status === 200, String(r.status));
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:00")}`, { token: tokenB }));
  ok("A6 still 404 for business B (the override is per business)", r.status === 404, String(r.status));

  // ── B. Configuration ───────────────────────────────────────────────────────────────────────────
  console.log("B. configuration");
  r = await routes.staff.POST(req("/api/appointments/staff", { method: "POST", body: { displayName: "דנה", color: "#3366cc" } }));
  const dana = (await body(r))?.staffMember;
  ok("B1 a staff member without login is created", r.status === 201 && dana?.displayName === "דנה");
  ok("B2 …and no user or account exists for her", (await n(`SELECT count(*)::int AS n FROM "User" WHERE "businessId" = ${bizA}`)) === 1);
  r = await routes.staff.POST(req("/api/appointments/staff", { method: "POST", body: { displayName: "יוסי" } }));
  const yossi = (await body(r))?.staffMember;
  r = await routes.staff.POST(req("/api/appointments/staff", { method: "POST", body: { displayName: "   " } }));
  ok("B3 a blank name is refused (400)", r.status === 400, String(r.status));
  const weekly = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
  r = await routes.availability.PUT(req("/api/appointments/availability", { method: "PUT", body: { rules: weekly } }));
  ok("B4 business hours Sun–Thu 09:00–17:00", r.status === 200 && (await body(r))?.rules?.length === 5);
  r = await routes.availability.PUT(req("/api/appointments/availability", { method: "PUT", body: { rules: weekly } }));
  ok("B5 the same PUT again leaves exactly five live rules", r.status === 200 && (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${bizA} AND "removedAt" IS NULL`)) === 5);
  r = await routes.availability.PUT(req("/api/appointments/availability", { method: "PUT", body: { rules: [{ weekday: 0, startMinute: 900, endMinute: 600 }] } }));
  ok("B6 a window that ends before it starts is refused", r.status === 400);
  r = await routes.exceptions.POST(req("/api/appointments/availability/exceptions", { method: "POST", body: { dayKey: MON, kind: "CLOSED", label: "חג" } }));
  ok("B7 the Monday of that week closed", r.status === 201);
  r = await routes.policy.PUT(req(`/api/appointments/services/${svcA}/policy`, { method: "PUT", body: { bufferAfterMinutes: 15, slotStepMinutes: 30 } }), p({ serviceId: String(svcA) }));
  ok("B8 the service's booking policy (15 minutes after, 30-minute step)", r.status === 200 && (await body(r))?.policy?.bufferAfterMinutes === 15);
  r = await routes.policy.PUT(req(`/api/appointments/services/${svcB}/policy`, { method: "PUT", body: { bufferAfterMinutes: 5 } }), p({ serviceId: String(svcB) }));
  ok("B9 another business's service → 404", r.status === 404, String(r.status));
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA }] } }), p({ staffId: String(dana.id) }));
  ok("B10 Dana performs the service", r.status === 200 && (await body(r))?.services?.length === 1);
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcB }] } }), p({ staffId: String(dana.id) }));
  ok("B11 assigning another business's service → 404", r.status === 404, String(r.status));
  const danaV = (await owner.staffMember.findUniqueOrThrow({ where: { id: dana.id } })).version;
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA }, { businessServiceId: svcA2 }], expectedVersion: danaV } }), p({ staffId: String(dana.id) }));
  const b11a = await body(r);
  ok("B11a adding a second service with the version read: 200, both held, version bumped", r.status === 200 && b11a?.services?.length === 2 && b11a.version === danaV + 1, JSON.stringify(b11a));
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA2 }], expectedVersion: danaV } }), p({ staffId: String(dana.id) }));
  ok("B11b a stale screen removing the first service → 409 VERSION_CONFLICT, nothing removed", r.status === 409 && (await body(r))?.error === "VERSION_CONFLICT"
    && (await n(`SELECT count(*)::int AS n FROM "StaffServiceAssignment" WHERE "staffMemberId" = ${dana.id} AND "removedAt" IS NULL`)) === 2);
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA }, { businessServiceId: svcA2 }], expectedVersion: danaV + 1 } }), p({ staffId: String(dana.id) }));
  ok("B11c saving the same list again: 200, version unchanged", r.status === 200 && (await body(r))?.version === danaV + 1);
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA }], expectedVersion: danaV + 1 } }), p({ staffId: String(dana.id) }));
  ok("B11d removing the second service leaves the first untouched (same row, never removed)", r.status === 200
    && (await n(`SELECT count(*)::int AS n FROM "StaffServiceAssignment" WHERE "staffMemberId" = ${dana.id} AND "businessServiceId" = ${svcA} AND "removedAt" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "StaffServiceAssignment" WHERE "staffMemberId" = ${dana.id} AND "businessServiceId" = ${svcA}`)) === 1);
  ok("B11e the catalog services are untouched", (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${bizA} AND id IN (${svcA}, ${svcA2}) AND "durationMinutes" IN (60, 90)`)) === 2);
  const raced = await Promise.all([svcA2, svcA2].map((x, i) => routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: i ? [] : [{ businessServiceId: svcA }, { businessServiceId: x }], expectedVersion: danaV + 2 } }), p({ staffId: String(dana.id) }))));
  ok("B11f two saves from the same version at once: exactly one wins, the other 409", raced.filter((x) => x.status === 200).length === 1 && raced.filter((x) => x.status === 409).length === 1, raced.map((x) => x.status).join(","));
  const cur = (await owner.staffMember.findUniqueOrThrow({ where: { id: dana.id } })).version;
  r = await routes.staffServices.PUT(req(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: svcA }], expectedVersion: cur } }), p({ staffId: String(dana.id) }));
  ok("B11g …and Dana is back to performing the one service", r.status === 200 && (await body(r))?.services?.length === 1);
  r = await routes.staffOne.PATCH(req(`/api/appointments/staff/${yossi.id}`, { method: "PATCH", body: { displayName: "יוסי כהן", expectedVersion: 1 } }), p({ staffId: String(yossi.id) }));
  ok("B12 a staff member is renamed (version 1 → 2)", r.status === 200 && (await body(r))?.staffMember?.version === 2);
  r = await routes.staffOne.PATCH(req(`/api/appointments/staff/${yossi.id}`, { method: "PATCH", body: { active: false, expectedVersion: 1 } }), p({ staffId: String(yossi.id) }));
  ok("B13 a stale version is refused (409)", r.status === 409, String(r.status));

  // ── C. Create ──────────────────────────────────────────────────────────────────────────────────
  console.log("C. create");
  const k1 = key();
  const c1Body = { businessServiceId: svcA, customerId: custA, staffMemberId: dana.id, startsAt: at("10:00") };
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: k1, body: c1Body }));
  const c1 = await body(r);
  ok("C1 a customer appointment: 201, CONFIRMED, the service's length, its buffer snapshot", r.status === 201
    && c1?.appointment?.status === "CONFIRMED" && c1.appointment.durationMinutes === 60 && c1.appointment.bufferAfterMinutes === 15
    && c1.appointment.endsAt === at("11:00") && c1.replayed === false, JSON.stringify(c1));
  const a1 = c1.appointment.id as number;
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: k1, body: c1Body }));
  const replay = await body(r);
  ok("C2 the same key and body → 200 replayed, the same appointment, still one row", r.status === 200 && replay?.replayed === true && replay.appointment.id === a1
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "endsAt" IS NOT NULL`)) === 1);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: k1, body: { ...c1Body, startsAt: at("14:00") } }));
  ok("C3 the same key with another body → 409 IDEMPOTENCY_KEY_REUSED", r.status === 409 && (await body(r))?.error === "IDEMPOTENCY_KEY_REUSED");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", body: c1Body }));
  ok("C4 a write without Idempotency-Key → 400", r.status === 400);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, startsAt: at("11:00") } }));
  const clash = await body(r);
  ok("C5 starting inside the 15-minute buffer → 409 SLOT_CONFLICT naming the appointment", r.status === 409 && clash?.error === "SLOT_CONFLICT"
    && JSON.stringify(clash.details?.conflictingAppointmentIds) === JSON.stringify([a1]), JSON.stringify(clash));
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, startsAt: at("11:15") } }));
  const c6 = (await body(r))?.appointment?.id as number;
  ok("C6 after the buffer → 201", r.status === 201 && c6 > 0);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { kind: "INTERNAL", title: "ישיבת צוות", startsAt: at("10:00"), durationMinutes: 30 } }));
  ok("C7 the business's own lane is separate from Dana's: an internal meeting at 10:00 → 201", r.status === 201);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { kind: "INTERNAL", title: "ישיבה", startsAt: at("18:00"), durationMinutes: 30 } }));
  const late = await body(r);
  ok("C8 after hours: created, with the warning OUTSIDE_AVAILABILITY", r.status === 201 && JSON.stringify(late?.warnings) === JSON.stringify(["OUTSIDE_AVAILABILITY"]));
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { kind: "BLOCK", startsAt: at("13:00"), durationMinutes: 120 } }));
  const block = (await body(r))?.appointment;
  ok("C9 a business-wide block 13:00–15:00", r.status === 201 && block?.kind === "BLOCK");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, startsAt: at("14:00") } }));
  ok("C10 the block closes Dana's lane too → 409", r.status === 409 && (await body(r))?.error === "SLOT_CONFLICT");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { kind: "BLOCK", customerId: custA, startsAt: at("16:00"), durationMinutes: 30 } }));
  ok("C11 a block naming a customer → 400", r.status === 400);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, customerId: custB, startsAt: at("09:00") } }));
  ok("C12 another business's customer → 404 CUSTOMER_NOT_FOUND", r.status === 404 && (await body(r))?.error === "CUSTOMER_NOT_FOUND");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { businessServiceId: svcA, staffMemberId: yossi.id, startsAt: at("09:00") } }));
  ok("C13 a staff member not assigned to the service → 409 STAFF_NOT_ASSIGNED", r.status === 409 && (await body(r))?.error === "STAFF_NOT_ASSIGNED");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { startsAt: "tomorrow", durationMinutes: 30 } }));
  ok("C14 an unreadable time → 400", r.status === 400);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { startsAt: at("09:00"), durationMinutes: 2 } }));
  ok("C15 a 2-minute appointment → 400", r.status === 400);

  // ── D. Concurrency ─────────────────────────────────────────────────────────────────────────────
  console.log("D. concurrency");
  const principal = { kind: "OWNER" as const, businessId: bizA, userId: userA };
  const race = await Promise.allSettled(Array.from({ length: 12 }, () =>
    schedule.createAppointment(principal, { idempotencyKey: key() }, { staffMemberId: dana.id, startsAt: at("09:00", TUE), durationMinutes: 45 })));
  const won = race.filter((x) => x.status === "fulfilled").length;
  const lost = race.filter((x) => x.status === "rejected" && (x.reason as { code?: string }).code === "SLOT_CONFLICT").length;
  ok("D1 twelve simultaneous bookings of one slot → exactly one, eleven SLOT_CONFLICT, nothing else", won === 1 && lost === 11, `won ${won}, conflict ${lost}`);
  ok("D2 the database holds exactly one", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("09:00", TUE).replace("T", " ").replace("Z", "")}'`)) === 1);
  const sameKey = key();
  const twin = await Promise.allSettled(Array.from({ length: 6 }, () =>
    schedule.createAppointment(principal, { idempotencyKey: sameKey }, { startsAt: at("12:00", TUE), durationMinutes: 30, kind: "INTERNAL", title: "x" })));
  const ids = new Set(twin.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<{ appointment: { id: number } }>).value.appointment.id));
  ok("D3 six simultaneous retries of one request → one appointment, every answer names it", ids.size === 1 && twin.every((x) => x.status === "fulfilled"));
  const sameHour = await Promise.all([dana.id, yossi.id].map((staffMemberId) =>
    routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { customerId: custA, staffMemberId, startsAt: at("15:00", WED), durationMinutes: 30 } }))));
  ok("D4 two staff members at the same hour: both booked (separate lanes)", sameHour.every((x) => x.status === 201), sameHour.map((x) => x.status).join(","));
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { customerId: custA, staffMemberId: yossi.id, startsAt: at("15:15", WED), durationMinutes: 30 } }));
  ok("D5 …and the same lane at that hour → 409 SLOT_CONFLICT", r.status === 409 && (await body(r))?.error === "SLOT_CONFLICT");

  // ── E. Move ────────────────────────────────────────────────────────────────────────────────────
  console.log("E. move");
  const sensorsBefore = await n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'APPOINTMENT_RESCHEDULED'`);
  r = await routes.reschedule.POST(req(`/api/appointments/${a1}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("11:30") } }), p({ id: String(a1) }));
  ok("E1 onto the appointment at 11:15 → 409 SLOT_CONFLICT", r.status === 409, String(r.status));
  r = await routes.reschedule.POST(req(`/api/appointments/${a1}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("09:00", WED), expectedVersion: 7 } }), p({ id: String(a1) }));
  ok("E2 a stale version → 409 VERSION_CONFLICT", r.status === 409 && (await body(r))?.error === "VERSION_CONFLICT");
  r = await routes.reschedule.POST(req(`/api/appointments/${a1}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("09:00", WED), expectedVersion: 1 } }), p({ id: String(a1) }));
  const moved = await body(r);
  ok("E3 a real move: 200, same length, version 2", r.status === 200 && moved?.appointment?.endsAt === at("10:00", WED) && moved.appointment.version === 2);
  ok("E4 …the learning sensor recorded the move (APPT-04 reads it)", (await n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'APPOINTMENT_RESCHEDULED'`)) === sensorsBefore + 1);
  ok("E5 …and the journal holds it, by the owner", (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = ${bizA} AND "appointmentId" = ${a1} AND "eventType" = 'APPOINTMENT_RESCHEDULED' AND actor = 'OWNER_USER' AND "actorUserId" = ${userA}`)) === 1);
  r = await routes.reschedule.POST(req(`/api/appointments/${block.id}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("13:30") } }), p({ id: String(block.id) }));
  ok("E6 moving a block records no learning sensor", r.status === 200 && (await n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'APPOINTMENT_RESCHEDULED'`)) === sensorsBefore + 1);

  // ── F. Status ──────────────────────────────────────────────────────────────────────────────────
  console.log("F. status");
  const statusBefore = await n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'APPOINTMENT_STATUS_CHANGED'`);
  r = await routes.status.POST(req(`/api/appointments/${a1}/status`, { method: "POST", key: key(), body: { to: "COMPLETED" } }), p({ id: String(a1) }));
  ok("F1 a future appointment cannot be completed → 409 NOT_STARTED", r.status === 409 && (await body(r))?.details?.reason === "NOT_STARTED");
  r = await routes.status.POST(req(`/api/appointments/${a1}/status`, { method: "POST", key: key(), body: { to: "NO_SHOW" } }), p({ id: String(a1) }));
  ok("F1a …nor marked a no-show → 409", r.status === 409);
  r = await routes.one.POST(req(`/api/appointments/${a1}`, { method: "POST", body: { action: "complete" } }), p({ id: String(a1) }));
  ok("F1b the route that predates milestone A cannot bypass it (complete) → 409", r.status === 409);
  r = await routes.one.POST(req(`/api/appointments/${a1}`, { method: "POST", body: { action: "no_show" } }), p({ id: String(a1) }));
  ok("F1c …nor no_show → 409, still CONFIRMED, nothing journalled", r.status === 409
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${a1} AND status = 'CONFIRMED'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${a1} AND "eventType" IN ('APPOINTMENT_COMPLETED', 'APPOINTMENT_NO_SHOW')`)) === 0);
  const yesterday = new Date(Date.now() - 26 * 3600_000);
  const past = (await owner.appointment.create({ data: { businessId: bizA, kind: "CUSTOMER", status: "CONFIRMED", customerId: custA, startsAt: yesterday, endsAt: new Date(yesterday.getTime() + 3600_000), durationMinutes: 60, createdByActor: "OWNER", createdByUserId: userA, sourceChannel: "INBOX_WEB" } })).id;
  const pastBlock = (await owner.appointment.create({ data: { businessId: bizA, kind: "BLOCK", status: "CONFIRMED", startsAt: new Date(yesterday.getTime() + 7200_000), endsAt: new Date(yesterday.getTime() + 10800_000), durationMinutes: 60, createdByActor: "OWNER", createdByUserId: userA, sourceChannel: "INBOX_WEB" } })).id;
  r = await routes.status.POST(req(`/api/appointments/${pastBlock}/status`, { method: "POST", key: key(), body: { to: "NO_SHOW" } }), p({ id: String(pastBlock) }));
  ok("F1d a block has no customer to be a no-show → 409", r.status === 409);
  r = await routes.status.POST(req(`/api/appointments/${past}/status`, { method: "POST", key: key(), body: { to: "COMPLETED" } }), p({ id: String(past) }));
  ok("F1e an appointment that has started: CONFIRMED → COMPLETED", r.status === 200 && (await body(r))?.appointment?.status === "COMPLETED");
  r = await routes.status.POST(req(`/api/appointments/${past}/status`, { method: "POST", key: key(), body: { to: "CANCELED" } }), p({ id: String(past) }));
  ok("F2 COMPLETED is terminal → 409 INVALID_TRANSITION", r.status === 409 && (await body(r))?.error === "INVALID_TRANSITION");
  r = await routes.status.POST(req(`/api/appointments/${block.id}/status`, { method: "POST", key: key(), body: { to: "COMPLETED" } }), p({ id: String(block.id) }));
  ok("F3 a block cannot be completed → 409", r.status === 409);
  r = await routes.status.POST(req(`/api/appointments/${block.id}/status`, { method: "POST", key: key(), body: { to: "CANCELED", cancelReason: "OWNER_CANCELED" } }), p({ id: String(block.id) }));
  ok("F4 a block is cancelled with its closed reason", r.status === 200 && (await body(r))?.appointment?.cancelReason === "OWNER_CANCELED");
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, startsAt: at("14:00") } }));
  ok("F5 the cancelled block frees the time → 201", r.status === 201, String(r.status));
  ok("F6 one sensor for the customer appointment, none for the block", (await n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'APPOINTMENT_STATUS_CHANGED'`)) === statusBefore + 1);
  r = await routes.status.POST(req(`/api/appointments/${a1}/status`, { method: "POST", key: key(), body: { to: "DELETED" } }), p({ id: String(a1) }));
  ok("F7 an unknown status → 400", r.status === 400);
  r = await routes.details.PATCH(req(`/api/appointments/${a1}/details`, { method: "PATCH", key: key(), body: { notes: "להביא תמונה", locationKind: "IN_PERSON" } }), p({ id: String(a1) }));
  ok("F8 details are edited and journalled without their text", r.status === 200
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${a1} AND "eventType" = 'APPOINTMENT_DETAILS_CHANGED' AND payload::text NOT LIKE '%להביא%'`)) === 1);

  // ── G. Reads and isolation ─────────────────────────────────────────────────────────────────────
  console.log("G. reads and isolation");
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:59")}`));
  const day = (await body(r))?.appointments as { id: number; staffMemberId: number | null }[];
  ok("G1 the day's calendar lists the live appointments (not the cancelled block)", r.status === 200 && day.length === 4 && !day.some((x) => x.id === block.id), JSON.stringify(day?.map((x) => x.id)));
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:59")}&staffMemberId=${dana.id}`));
  ok("G2 Dana's lane only", r.status === 200 && ((await body(r))?.appointments as { staffMemberId: number }[]).every((x) => x.staffMemberId === dana.id));
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("00:00", addCalendarDays(SUN, 70))}`));
  ok("G3 a range over 62 days → 400", r.status === 400);
  r = await routes.one.GET(req(`/api/appointments/${a1}`), p({ id: String(a1) }));
  const detail = await body(r);
  ok("G4 one appointment with its history", r.status === 200 && detail?.appointment?.id === a1 && detail.history.length >= 3);
  await owner.businessFeatureAccess.create({ data: { businessId: bizB, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  r = await routes.one.GET(req(`/api/appointments/${a1}`, { token: tokenB }), p({ id: String(a1) }));
  ok("G5 business B asking for A's appointment → 404", r.status === 404, String(r.status));
  r = await routes.root.GET(req(`/api/appointments?from=${at("00:00")}&to=${at("23:59")}`, { token: tokenB }));
  ok("G6 business B's calendar is empty", r.status === 200 && ((await body(r))?.appointments as unknown[]).length === 0);
  r = await routes.status.POST(req(`/api/appointments/${a1}/status`, { method: "POST", key: key(), body: { to: "NO_SHOW" }, token: tokenB }), p({ id: String(a1) }));
  ok("G7 business B changing A's appointment → 404, nothing changed", r.status === 404 && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${a1} AND status = 'CONFIRMED'`)) === 1);
  r = await routes.staffOne.PATCH(req(`/api/appointments/staff/${dana.id}`, { method: "PATCH", body: { active: false }, token: tokenB }), p({ staffId: String(dana.id) }));
  ok("G8 business B deactivating A's staff member → 404", r.status === 404);
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), token: tokenB, body: { staffMemberId: dana.id, startsAt: at("09:00"), durationMinutes: 30 } }));
  ok("G9 business B booking on A's staff member → 404 STAFF_NOT_FOUND", r.status === 404 && (await body(r))?.error === "STAFF_NOT_FOUND");

  // a1 (still CONFIRMED: a future appointment cannot be completed) is cancelled — a terminal appointment frees its time (H0).
  r = await routes.status.POST(req(`/api/appointments/${a1}/status`, { method: "POST", key: key(), body: { to: "CANCELED", cancelReason: "OWNER_CANCELED" } }), p({ id: String(a1) }));
  ok("G10 the future appointment is cancelled instead", r.status === 200, String(r.status));

  // ── H. Free slots ──────────────────────────────────────────────────────────────────────────────
  console.log("H. free slots");
  // The appointment moved to Wednesday 09:00 in E was completed in F, which frees its time; an active one takes it.
  r = await routes.root.POST(req("/api/appointments", { method: "POST", key: key(), body: { ...c1Body, startsAt: at("09:00", WED) } }));
  ok("H0 an active appointment on Wednesday 09:00 (where the cancelled one was — cancelling freed the time)", r.status === 201, String(r.status));
  r = await routes.slots.GET(req(`/api/appointments/slots?fromDay=${WED}&toDay=${WED}&businessServiceId=${svcA}&staffMemberId=${dana.id}`));
  const sl = await body(r);
  const starts = (sl?.slots as { startsAt: string }[] | undefined)?.map((s) => s.startsAt) ?? [];
  ok("H1 the service's length, a 30-minute step: the first free start is 10:30, twelve in all", r.status === 200 && sl.durationMinutes === 60
    && starts[0] === at("10:30", WED) && starts.length === 12, JSON.stringify(starts));
  ok("H2 09:00 is taken (the active appointment) and 10:00 is inside its 15-minute buffer", !starts.includes(at("09:00", WED)) && !starts.includes(at("10:00", WED)));
  ok("H3 the last slot ends at 17:00", starts[starts.length - 1] === at("16:00", WED));
  r = await routes.slots.GET(req(`/api/appointments/slots?fromDay=${MON}&toDay=${MON}&businessServiceId=${svcA}`));
  ok("H4 the closed Monday has no slot", r.status === 200 && (await body(r))?.slots?.length === 0);
  r = await routes.slots.GET(req(`/api/appointments/slots?fromDay=${SUN}&toDay=${addCalendarDays(SUN, 40)}&durationMinutes=30`));
  ok("H5 more than 31 days → 400", r.status === 400);

  // ── I. The paths that predate milestone A ──────────────────────────────────────────────────────
  console.log("I. existing paths");
  const ownerCtx = { actor: "OWNER" as const, userId: userA, sourceChannel: "INBOX_WEB" as const };
  const untimed = await legacy.create({ businessId: bizA, actor: ownerCtx, details: { title: "בלי שעה" } });
  ok("I1 create without a time: PROPOSED, no end, no staff, CUSTOMER", untimed.ok && untimed.appointment.status === "PROPOSED" && untimed.appointment.endsAt === null && untimed.appointment.kind === "CUSTOMER");
  const conv = await owner.conversation.create({ data: { businessId: bizA, channel: "WHATSAPP", customerId: custA } });
  const msg = await owner.message.create({ data: { businessId: bizA, conversationId: conv.id, channel: "WHATSAPP", direction: "INBOUND", senderType: "CUSTOMER" } });
  await owner.conversation.update({ where: { id: conv.id }, data: { pendingAppointmentRequest: { createdAt: new Date().toISOString(), createdByOwnerId: userA, originMessageId: msg.id, customerHint: "אפשר ביום שלישי" } } });
  const converted = await legacy.createFromPending({ conversationId: conv.id, businessId: bizA, actor: ownerCtx, businessServiceId: svcA });
  ok("I2 conversion of a pending request: PROPOSED, linked to the customer and the service, untimed", converted.ok && converted.appointment.customerId === custA
    && converted.appointment.businessServiceId === svcA && converted.appointment.endsAt === null);
  ok("I3 …the pending request is cleared and a BOOKING demand signal written (P1 unchanged)",
    (await n(`SELECT count(*)::int AS n FROM "Conversation" WHERE id = ${conv.id} AND "pendingAppointmentRequest" IS NULL`)) === 1
    && converted.ok && (await n(`SELECT count(*)::int AS n FROM "OfferingDemandSignal" WHERE "appointmentId" = ${converted.appointment.id}`)) === 1);
  const resched = untimed.ok ? await legacy.reschedule({ appointmentId: untimed.appointment.id, businessId: bizA, actor: ownerCtx, startsAt: new Date(at("09:00")), durationMinutes: 30 }) : null;
  ok("I4 the old reschedule still moves an untimed appointment (and leaves it untimed)", !!resched?.ok && resched.appointment.endsAt === null);
  const refusedOld = await legacy.reschedule({ appointmentId: c6, businessId: bizA, actor: ownerCtx, startsAt: new Date(at("09:00")) });
  ok("I5 the old reschedule refuses a timed appointment (it would bypass the overlap check)", !refusedOld.ok && refusedOld.reason === "invalid_input");
  r = untimed.ok ? await routes.one.POST(req(`/api/appointments/${untimed.appointment.id}`, { method: "POST", body: { action: "cancel", reason: "ביטול טלפוני" } }), p({ id: String(untimed.appointment.id) })) : new Response(null, { status: 599 });
  const cx = await body(r);
  ok("I6 the old POST route cancels, keeps the free-text reason in notes, sets the closed reason", r.status === 200 && cx?.appointment?.status === "CANCELED"
    && cx.appointment.cancelReason === "OWNER_CANCELED" && String(cx.appointment.notes).includes("ביטול טלפוני"));
  ok("I7 every path journalled: created ×2, rescheduled, cancelled — each by the owner",
    untimed.ok && converted.ok && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" IN (${untimed.appointment.id}, ${converted.appointment.id}) AND actor = 'OWNER_USER' AND "actorUserId" = ${userA}`)) === 4);

  // ── J. Learning ────────────────────────────────────────────────────────────────────────────────
  console.log("J. learning");
  const obs = await loadAppointments(bizA, new Date(at("00:00", addCalendarDays(SUN, 30))), 365);
  const kinds = await owner.appointment.findMany({ where: { id: { in: obs.map((o) => o.recordId) } }, select: { kind: true } });
  ok("J1 the evidence loader reads customer appointments only", obs.length > 0 && kinds.every((k) => k.kind === "CUSTOMER"), `${obs.length} observations`);
  ok("J2 …and every customer appointment of the window", obs.length === (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND kind = 'CUSTOMER'`)));

  // ── K. Decision 6 ──────────────────────────────────────────────────────────────────────────────
  console.log("K. decision 6");
  const byCustomer = await legacy.create({ businessId: bizA, actor: { actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" } });
  ok("K1 a CUSTOMER action: no creator user, a CUSTOMER journal event with no user", byCustomer.ok && byCustomer.appointment.createdByUserId === null
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${byCustomer.appointment.id} AND actor = 'CUSTOMER' AND "actorUserId" IS NULL`)) === 1);
  const sysAttempt = await legacy.create({ businessId: bizA, actor: { actor: "SYSTEM", userId: userA, sourceChannel: "IMPORT" } });
  ok("K2 a SYSTEM action attributed to the owner is refused", !sysAttempt.ok);
  const noOwner = await legacy.create({ businessId: bizA, actor: { actor: "OWNER", userId: null, sourceChannel: "INBOX_WEB" } });
  ok("K3 an OWNER action without a user is refused", !noOwner.ok);
  ok("K4 no owner-API appointment lacks its creator", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "createdByActor" = 'OWNER' AND "createdByUserId" IS NULL`)) === 0);

  // ── L. A failed journal write undoes the whole change (the paths that predate milestone A) ─────────
  // Fault injection in the LAB only: an owner-installed trigger makes every journal INSERT of business A raise. The
  // application code is untouched; the routes are the real ones. Then the fault is removed and the same call succeeds.
  console.log("L. journal failure is atomic");
  const victim = await legacy.create({ businessId: bizA, actor: ownerCtx, details: { title: "לפני תקלה" } });
  const conv2 = await owner.conversation.create({ data: { businessId: bizA, channel: "WHATSAPP", customerId: custA } });
  const msg2 = await owner.message.create({ data: { businessId: bizA, conversationId: conv2.id, channel: "WHATSAPP", direction: "INBOUND", senderType: "CUSTOMER" } });
  await owner.conversation.update({ where: { id: conv2.id }, data: { pendingAppointmentRequest: { createdAt: new Date().toISOString(), createdByOwnerId: userA, originMessageId: msg2.id, customerHint: "מחר בבוקר" } } });
  const convRoute = await import("@/app/api/conversations/[id]/appointment/route");
  const snap = async (id: number) => JSON.stringify(await owner.appointment.findUnique({ where: { id }, select: { status: true, version: true, notes: true, cancelReason: true, updatedAt: true } }));
  const events = () => n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = ${bizA}`);
  const sensors = () => n(`SELECT count(*)::int AS n FROM "LearningEvent" WHERE "businessId" = ${bizA}`);
  const apptCount = () => n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA}`);
  const demand = () => n(`SELECT count(*)::int AS n FROM "OfferingDemandSignal" WHERE "businessId" = ${bizA}`);
  const pending = () => n(`SELECT count(*)::int AS n FROM "Conversation" WHERE id = ${conv2.id} AND "pendingAppointmentRequest" IS NOT NULL`);
  const vid = victim.ok ? victim.appointment.id : 0;
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.appt_lab_journal_fault() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW."businessId" = ${bizA} THEN RAISE EXCEPTION 'lab fault: journal write refused' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$`);
  await owner.$executeRawUnsafe(`CREATE TRIGGER "appt_lab_journal_fault" BEFORE INSERT ON "AppointmentEvent" FOR EACH ROW EXECUTE FUNCTION public.appt_lab_journal_fault()`);
  try {
    const before = await snap(vid), ev0 = await events(), se0 = await sensors();
    r = await routes.one.POST(req(`/api/appointments/${vid}`, { method: "POST", body: { action: "confirm" } }), p({ id: String(vid) }));
    ok("L1 journal fails on the old POST confirm → 500, not a success", r.status === 500, String(r.status));
    ok("L2 …the appointment is exactly as before: status, version, notes, cancel reason, updatedAt", (await snap(vid)) === before, `${before} → ${await snap(vid)}`);
    ok("L3 …no journal event and no learning sensor was written", (await events()) === ev0 && (await sensors()) === se0);
    r = await routes.one.POST(req(`/api/appointments/${vid}`, { method: "POST", body: { action: "cancel", reason: "ביטול בזמן תקלה" } }), p({ id: String(vid) }));
    ok("L4 journal fails on the old POST cancel → 500; the row is untouched (no status, no reason in notes, no closed reason)", r.status === 500 && (await snap(vid)) === before, String(r.status));
    const ap0 = await apptCount(), ds0 = await demand();
    r = await convRoute.POST(req(`/api/conversations/${conv2.id}/appointment`, { method: "POST", body: { businessServiceId: svcA } }), p({ id: String(conv2.id) }));
    ok("L5 journal fails on the conversion of a pending request → 500", r.status === 500, String(r.status));
    ok("L6 …no appointment, no demand signal, no event, no sensor; the pending request is still there",
      (await apptCount()) === ap0 && (await demand()) === ds0 && (await events()) === ev0 && (await sensors()) === se0 && (await pending()) === 1);
  } finally {
    await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "appt_lab_journal_fault" ON "AppointmentEvent"`);
    await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.appt_lab_journal_fault()`);
  }
  const ev1 = await events();
  r = await routes.one.POST(req(`/api/appointments/${vid}`, { method: "POST", body: { action: "confirm" } }), p({ id: String(vid) }));
  const healed = await owner.appointment.findUnique({ where: { id: vid }, select: { status: true, version: true } });
  ok("L7 fault removed: the same confirm succeeds — CONFIRMED, version 2, exactly one new event", r.status === 200 && healed?.status === "CONFIRMED" && healed.version === 2 && (await events()) === ev1 + 1, JSON.stringify(healed));
  r = await convRoute.POST(req(`/api/conversations/${conv2.id}/appointment`, { method: "POST", body: { businessServiceId: svcA } }), p({ id: String(conv2.id) }));
  ok("L8 fault removed: the same conversion succeeds and clears the pending request", r.status === 200 && (await pending()) === 0, String(r.status));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await owner.$disconnect();
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  });
