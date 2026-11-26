/**
 * Calendar daily use (G7, G8, G11, G12) — the new and changed owner routes, end to end AS the restricted runtime
 * (DATABASE_URL = app_runtime_prod, NOSUPERUSER NOBYPASSRLS) on the Production-shaped lab (.appt/lab.sh --with-appt
 * chain, as appointments-calendar-ci.yml builds it). The real route handlers are called with real signed session
 * tokens; the owner connection only builds fixtures and reads back.
 *
 *   Q. GET /api/appointments/search?q= — name or phone digits, upcoming first (soonest first) then past (latest first),
 *      at most 30, erased rows never, business B never sees A's rows; < 2 characters → 400; no session → 401; the
 *      per-user limit answers 429.
 *   S. PATCH /api/business/services/[id] — price (FIXED / NO_PUBLIC_PRICE) and active; bad price → 400 and nothing
 *      changes; a deactivated service cannot be booked (server) while an existing appointment keeps it; B cannot edit A's.
 *   D. PATCH /api/appointments/[id]/details — change customer and service; the length changes only when sent
 *      (the owner's confirmation) and is re-checked for overlap under the lock (409, nothing written); an inactive
 *      service is refused; journalled as APPOINTMENT_DETAILS_CHANGED with from/to ids; B cannot patch A's (404).
 *   C. POST / DELETE /api/appointments/availability/exceptions/range — a dry run writes nothing; one row per day in one
 *      call; a repeat skips; DELETE removes closures only (a different-hours day stays); appointments on the days are counted and never touched; 63 days → 400; another business's
 *      staff → 404; B's DELETE leaves A's rows alone.
 *   H. GET / POST /api/appointments/availability/holidays — the table's upcoming days; holidays closed all day, eves
 *      from the closing time; dates never taken from the request (unknown id → 400).
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 */
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "appt-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "appt-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
process.env.RATE_LIMIT_BACKEND = process.env.RATE_LIMIT_BACKEND || "memory";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const routes = {
    search: await import("@/app/api/appointments/search/route"),
    details: await import("@/app/api/appointments/[id]/details/route"),
    service: await import("@/app/api/business/services/[id]/route"),
    appointments: await import("@/app/api/appointments/route"),
    range: await import("@/app/api/appointments/availability/exceptions/range/route"),
    holidays: await import("@/app/api/appointments/availability/holidays/route"),
  };

  const tag = `appt-du-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: `${tag}-A` } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  for (const businessId of [bizA, bizB]) {
    await owner.businessFeatureAccess.upsert({
      where: { businessId_featureKey: { businessId, featureKey: "appointments" } },
      create: { businessId, featureKey: "appointments", state: "ENABLED", reason: "lab" },
      update: { state: "ENABLED" },
    });
  }
  const tokenA = signAuthToken(userA, 0);
  const tokenB = signAuthToken(userB, 0);
  const principalA = { kind: "OWNER" as const, businessId: bizA, userId: userA };

  const BASE = "https://app.example.com";
  const req = (path: string, init: { method?: string; body?: unknown; token?: string | null; key?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = init.token === undefined ? tokenA : init.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
  const body = async (r: Response) => { try { return await r.json(); } catch { return null; } };
  const key = () => uuidV7(new Date());
  const book = (input: Record<string, unknown>) => schedule.createAppointment(principalA, { idempotencyKey: key() }, input);

  const today = jerusalemDayKey(new Date());
  const day = addCalendarDays(today, 5);
  const at = (d: string, h: number, m = 0) => jerusalemInstantAt(d, h, m).toISOString();

  // ── Q. Search ──────────────────────────────────────────────────────────────────────────────────
  console.log("Q. GET /api/appointments/search");
  const dana = await owner.customer.create({ data: { businessId: bizA, name: "דנה כהן", phone: "972501234567" } });
  const other = await owner.customer.create({ data: { businessId: bizA, name: "יוסי לוי", phone: "972529876543" } });
  const danaB = await owner.customer.create({ data: { businessId: bizB, name: "דנה ממול", phone: "972501234567" } });
  const mk = (businessId: number, userId: number, customerId: number, start: Date, extra: Record<string, unknown> = {}) => owner.appointment.create({
    data: {
      businessId, kind: "CUSTOMER", status: "CONFIRMED", startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000), durationMinutes: 30,
      customerId, createdByActor: "OWNER", createdByUserId: userId, sourceChannel: "INBOX_WEB", ...extra,
    },
  });
  const up2 = await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, 9), 10)));
  const up1 = await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, 2), 10)));
  const past1 = await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, -3), 10)));
  const past2 = await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, -20), 10)));
  const erased = await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, 4), 10)), { erasedAt: new Date() });
  await mk(bizA, userA, other.id, new Date(at(addCalendarDays(today, 3), 10)));
  const bRow = await mk(bizB, userB, danaB.id, new Date(at(addCalendarDays(today, 2), 11)));

  let r = await routes.search.GET(req(`/api/appointments/search?q=${encodeURIComponent("דנה")}`));
  let ids: number[] = ((await body(r))?.results ?? []).map((x: { id: number }) => x.id);
  ok("Q1 by name: upcoming soonest first, then past latest first", r.status === 200 && JSON.stringify(ids) === JSON.stringify([up1.id, up2.id, past1.id, past2.id]), JSON.stringify(ids));
  ok("Q2 an erased appointment never appears", !ids.includes(erased.id));
  r = await routes.search.GET(req(`/api/appointments/search?q=${encodeURIComponent("050-123 4567")}`));
  ids = ((await body(r))?.results ?? []).map((x: { id: number }) => x.id);
  ok("Q3 by phone, typed in local form", r.status === 200 && ids.length === 4 && ids[0] === up1.id, JSON.stringify(ids));
  r = await routes.search.GET(req(`/api/appointments/search?q=${encodeURIComponent("דנה")}`, { token: tokenB }));
  ids = ((await body(r))?.results ?? []).map((x: { id: number }) => x.id);
  ok("Q4 business B searching the same name/phone sees only its own row", r.status === 200 && JSON.stringify(ids) === JSON.stringify([bRow.id]), JSON.stringify(ids));
  r = await routes.search.GET(req(`/api/appointments/search?q=0501234567`, { token: tokenB }));
  ids = ((await body(r))?.results ?? []).map((x: { id: number }) => x.id);
  ok("Q5 …also by phone (A's customer has the same number)", JSON.stringify(ids) === JSON.stringify([bRow.id]), JSON.stringify(ids));
  const shortCodes = await Promise.all(["ד", "", "05", "x".repeat(61)].map(async (q) => (await routes.search.GET(req(`/api/appointments/search?q=${encodeURIComponent(q)}`))).status));
  ok("Q6 under 2 characters / too long → 400", shortCodes.every((c) => c === 400), shortCodes.join(","));
  r = await routes.search.GET(req(`/api/appointments/search?q=abc`, { token: null }));
  ok("Q7 no session → 401", r.status === 401, String(r.status));
  const many = await owner.customer.create({ data: { businessId: bizA, name: "רב תורים" } });
  await owner.appointment.createMany({
    data: Array.from({ length: 40 }, (_, i) => {
      const start = new Date(at(addCalendarDays(today, 30 + i), 9));
      return { businessId: bizA, kind: "CUSTOMER" as const, status: "CONFIRMED" as const, startsAt: start, endsAt: new Date(start.getTime() + 15 * 60_000), durationMinutes: 15, customerId: many.id, createdByActor: "OWNER" as const, createdByUserId: userA, sourceChannel: "INBOX_WEB" as const };
    }),
  });
  r = await routes.search.GET(req(`/api/appointments/search?q=${encodeURIComponent("רב תורים")}`));
  const capped = (await body(r))?.results ?? [];
  ok("Q8 at most 30 results", r.status === 200 && capped.length === 30, String(capped.length));

  // ── S. Services: price and active ──────────────────────────────────────────────────────────────
  console.log("S. PATCH /api/business/services/[id] — price and active");
  const svc = await owner.businessService.create({ data: { businessId: bizA, name: "תספורת", type: "SERVICE", durationMinutes: 30, priceMode: "NO_PUBLIC_PRICE" } });
  const svc2 = await owner.businessService.create({ data: { businessId: bizA, name: "צבע", type: "SERVICE", durationMinutes: 90, priceMode: "FIXED", priceAmount: 250 } });
  const svcB = await owner.businessService.create({ data: { businessId: bizB, name: "עיסוי", type: "SERVICE", durationMinutes: 60, priceMode: "FIXED", priceAmount: 200 } });
  r = await routes.service.PATCH(req(`/api/business/services/${svc.id}`, { method: "PATCH", body: { priceMode: "FIXED", priceAmount: 120 } }), p({ id: String(svc.id) }));
  let row = await owner.businessService.findUniqueOrThrow({ where: { id: svc.id } });
  const svcOut = (await body(r))?.service;
  ok("S1 a fixed price is set (and answered)", r.status === 200 && row.priceMode === "FIXED" && String(row.priceAmount) === "120" && svcOut?.priceAmount === "120", `${r.status} ${row.priceMode} ${row.priceAmount}`);
  const badPrice = [{ priceMode: "FIXED" }, { priceMode: "FIXED", priceAmount: -1 }, { priceMode: "BANANA", priceAmount: 1 }, { priceAmount: 5 }, { priceMode: "NO_PUBLIC_PRICE", priceAmount: 5 }, { active: "no" }];
  const badCodes: number[] = [];
  for (const x of badPrice) badCodes.push((await routes.service.PATCH(req(`/api/business/services/${svc.id}`, { method: "PATCH", body: x }), p({ id: String(svc.id) }))).status);
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svc.id } });
  ok("S2 bad price / status input → 400, nothing changes", badCodes.every((c) => c === 400) && row.priceMode === "FIXED" && String(row.priceAmount) === "120" && row.active, badCodes.join(","));
  r = await routes.service.PATCH(req(`/api/business/services/${svcB.id}`, { method: "PATCH", body: { priceMode: "NO_PUBLIC_PRICE", active: false } }), p({ id: String(svcB.id) }));
  const bRowSvc = await owner.businessService.findUniqueOrThrow({ where: { id: svcB.id } });
  ok("S3 A cannot edit B's service price or status (404, untouched)", r.status === 404 && bRowSvc.active && bRowSvc.priceMode === "FIXED", String(r.status));
  const kept = (await book({ startsAt: at(day, 9), customerId: dana.id, businessServiceId: svc2.id })).appointment;
  r = await routes.service.PATCH(req(`/api/business/services/${svc2.id}`, { method: "PATCH", body: { active: false } }), p({ id: String(svc2.id) }));
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svc2.id } });
  ok("S4 a service is deactivated", r.status === 200 && row.active === false, String(r.status));
  r = await routes.appointments.POST(req(`/api/appointments`, { method: "POST", key: key(), body: { startsAt: at(day, 15), customerId: dana.id, businessServiceId: svc2.id } }));
  ok("S5 a deactivated service cannot be booked (server: 404 SERVICE_NOT_FOUND)", r.status === 404 && (await body(r))?.error === "SERVICE_NOT_FOUND", String(r.status));
  const keptNow = await owner.appointment.findUniqueOrThrow({ where: { id: kept.id } });
  ok("S6 the existing appointment keeps its (now inactive) service", keptNow.businessServiceId === svc2.id && keptNow.status === "CONFIRMED");
  r = await routes.service.PATCH(req(`/api/business/services/${svc.id}`, { method: "PATCH", body: { priceMode: "NO_PUBLIC_PRICE" } }), p({ id: String(svc.id) }));
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svc.id } });
  ok("S7 the price can be removed (no public price)", r.status === 200 && row.priceMode === "NO_PUBLIC_PRICE" && row.priceAmount === null);
  r = await routes.service.PATCH(req(`/api/business/services/${svc2.id}`, { method: "PATCH", body: { active: true } }), p({ id: String(svc2.id) }));
  ok("S8 and reactivated", r.status === 200 && (await owner.businessService.findUniqueOrThrow({ where: { id: svc2.id } })).active === true);

  // ── D. Details: customer and service ───────────────────────────────────────────────────────────
  console.log("D. PATCH /api/appointments/[id]/details — customer and service");
  const appt = (await book({ startsAt: at(day, 11), customerId: dana.id, businessServiceId: svc.id })).appointment; // 11:00–11:30
  await book({ startsAt: at(day, 12), customerId: other.id, durationMinutes: 30 }); // 12:00–12:30 on the business lane
  const patch = (id: number, b: Record<string, unknown>, token?: string | null) => routes.details.PATCH(req(`/api/appointments/${id}/details`, { method: "PATCH", key: key(), body: b, token }), p({ id: String(id) }));
  r = await patch(appt.id, { customerId: other.id, expectedVersion: appt.version });
  let a = await owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  ok("D1 the customer is changed", r.status === 200 && a.customerId === other.id && a.version === appt.version + 1, String(r.status));
  r = await patch(appt.id, { businessServiceId: svc2.id, expectedVersion: a.version });
  const afterSvc = await owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  ok("D2 the service is changed; the length stays (not confirmed)", r.status === 200 && afterSvc.businessServiceId === svc2.id && afterSvc.durationMinutes === 30 && afterSvc.endsAt?.getTime() === a.endsAt?.getTime(), String(r.status));
  ok("D3 the title that followed the old service follows the new one", afterSvc.title === "צבע", String(afterSvc.title));
  r = await patch(appt.id, { durationMinutes: 90, expectedVersion: afterSvc.version });
  const conflict = await body(r);
  const still = await owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  ok("D4 the confirmed longer length overlaps 12:00 → 409 SLOT_CONFLICT, nothing written", r.status === 409 && conflict?.error === "SLOT_CONFLICT" && still.durationMinutes === 30 && still.version === afterSvc.version, `${r.status} ${JSON.stringify(conflict)}`);
  r = await patch(appt.id, { durationMinutes: 60, expectedVersion: afterSvc.version });
  a = await owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  ok("D5 a length that fits is saved (11:00–12:00)", r.status === 200 && a.durationMinutes === 60 && a.endsAt?.toISOString() === at(day, 12), String(r.status));
  await owner.businessService.update({ where: { id: svc.id }, data: { active: false } });
  r = await patch(appt.id, { businessServiceId: svc.id, expectedVersion: a.version });
  ok("D6 an inactive service cannot be chosen (404 SERVICE_NOT_FOUND)", r.status === 404 && (await body(r))?.error === "SERVICE_NOT_FOUND", String(r.status));
  await owner.businessService.update({ where: { id: svc.id }, data: { active: true } });
  r = await patch(appt.id, { businessServiceId: svcB.id, expectedVersion: a.version });
  ok("D7 another business's service → 404", r.status === 404, String(r.status));
  r = await patch(appt.id, { customerId: danaB.id, expectedVersion: a.version });
  ok("D8 another business's customer → 404 CUSTOMER_NOT_FOUND", r.status === 404 && (await body(r))?.error === "CUSTOMER_NOT_FOUND", String(r.status));
  r = await patch(appt.id, { customerId: danaB.id, expectedVersion: a.version }, tokenB);
  a = await owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  ok("D9 business B cannot patch A's appointment (404, untouched)", r.status === 404 && a.customerId === other.id, String(r.status));
  const events = await owner.appointmentEvent.findMany({ where: { appointmentId: appt.id, eventType: "APPOINTMENT_DETAILS_CHANGED" }, orderBy: { id: "asc" } });
  const pl = events.map((e) => e.payload as Record<string, unknown>);
  ok("D10 journalled: customer from/to, service from/to, the length's new end", events.length === 3
    && pl[0].fromCustomerId === dana.id && pl[0].toCustomerId === other.id
    && pl[1].fromServiceId === svc.id && pl[1].toServiceId === svc2.id
    && (pl[2].fields as string[]).includes("durationMinutes") && pl[2].toEndsAt === at(day, 12), JSON.stringify(pl));
  const internal = (await book({ kind: "INTERNAL", title: "ישיבה", startsAt: at(day, 16), durationMinutes: 30 })).appointment;
  r = await patch(internal.id, { businessServiceId: svc.id });
  ok("D11 a meeting cannot take a service (400)", r.status === 400, String(r.status));

  // ── C. Closure ranges ──────────────────────────────────────────────────────────────────────────
  console.log("C. closure ranges");
  const staffA = await owner.staffMember.create({ data: { businessId: bizA, displayName: "נועה" } });
  const staffB = await owner.staffMember.create({ data: { businessId: bizB, displayName: "רוני" } });
  const from = addCalendarDays(today, 40);
  const to = addCalendarDays(today, 42);
  await mk(bizA, userA, dana.id, new Date(at(addCalendarDays(today, 41), 10)), { staffMemberId: staffA.id });
  const exCount = (businessId: number) => owner.availabilityException.count({ where: { businessId, removedAt: null } });
  const before = await exCount(bizA);
  r = await routes.range.POST(req(`/api/appointments/availability/exceptions/range`, { method: "POST", body: { staffMemberId: staffA.id, fromDay: from, toDay: to, label: "חופשה", dryRun: true } }));
  let out = await body(r);
  ok("C1 a dry run counts 3 days and 1 appointment, writes nothing", r.status === 200 && out?.created === 3 && out?.appointmentsAffected === 1 && (await exCount(bizA)) === before, JSON.stringify(out));
  r = await routes.range.POST(req(`/api/appointments/availability/exceptions/range`, { method: "POST", body: { staffMemberId: staffA.id, fromDay: from, toDay: to, label: "חופשה" } }));
  out = await body(r);
  const rows = await owner.availabilityException.findMany({ where: { businessId: bizA, staffMemberId: staffA.id, removedAt: null }, orderBy: { dayKey: "asc" } });
  ok("C2 one whole-day closure per day, for the staff member", r.status === 201 && rows.length === 3 && rows.every((x) => x.kind === "CLOSED" && x.startMinute === null && x.label === "חופשה") && rows[0].dayKey.toISOString().slice(0, 10) === from, JSON.stringify(out));
  const apptStill = await owner.appointment.count({ where: { businessId: bizA, staffMemberId: staffA.id, status: "CONFIRMED" } });
  ok("C3 the appointment on those days is untouched (warning only)", apptStill === 1 && out?.appointmentsAffected === 1);
  r = await routes.range.POST(req(`/api/appointments/availability/exceptions/range`, { method: "POST", body: { staffMemberId: staffA.id, fromDay: from, toDay: addCalendarDays(to, 1) } }));
  out = await body(r);
  ok("C4 a repeat skips the closed days and adds only the new one", r.status === 201 && out?.created === 1 && out?.skipped === 3, JSON.stringify(out));
  r = await routes.range.POST(req(`/api/appointments/availability/exceptions/range`, { method: "POST", body: { fromDay: from, toDay: addCalendarDays(from, 62) } }));
  ok("C5 63 days → 400", r.status === 400, String(r.status));
  r = await routes.range.POST(req(`/api/appointments/availability/exceptions/range`, { method: "POST", body: { staffMemberId: staffB.id, fromDay: from, toDay: to } }));
  ok("C6 another business's staff member → 404, nothing written", r.status === 404 && (await exCount(bizB)) === 0, String(r.status));
  r = await routes.range.DELETE(req(`/api/appointments/availability/exceptions/range`, { method: "DELETE", token: tokenB, body: { staffMemberId: staffA.id, fromDay: from, toDay: to } }));
  ok("C7 B removing a range with A's staff id → 404, A's rows untouched", r.status === 404 && (await owner.availabilityException.count({ where: { businessId: bizA, staffMemberId: staffA.id, removedAt: null } })) === 4, String(r.status));
  r = await routes.range.DELETE(req(`/api/appointments/availability/exceptions/range`, { method: "DELETE", token: tokenB, body: { fromDay: from, toDay: to } }));
  ok("C8 B removing its own business range touches nothing of A", r.status === 200 && (await body(r))?.removed === 0 && (await exCount(bizA)) === before + 4, String(r.status));
  const openRow = await owner.availabilityException.create({ data: { businessId: bizA, staffMemberId: staffA.id, dayKey: new Date(`${from}T00:00:00.000Z`), kind: "OPEN_HOURS", startMinute: 600, endMinute: 900, label: "שעות שונות" } });
  r = await routes.range.DELETE(req(`/api/appointments/availability/exceptions/range`, { method: "DELETE", body: { staffMemberId: staffA.id, fromDay: from, toDay: to } }));
  out = await body(r);
  ok("C10 a different-hours day inside the range is NOT removed (closures only)", (await owner.availabilityException.findUniqueOrThrow({ where: { id: openRow.id } })).removedAt === null);
  await owner.availabilityException.update({ where: { id: openRow.id }, data: { removedAt: new Date() } });
  ok("C9 A removes the range: 3 closures marked removed (kept as history), the 4th day stays", r.status === 200 && out?.removed === 3 && (await owner.availabilityException.count({ where: { businessId: bizA, staffMemberId: staffA.id, kind: "CLOSED", removedAt: null } })) === 1 && (await owner.availabilityException.count({ where: { businessId: bizA, staffMemberId: staffA.id, kind: "CLOSED" } })) === 4, JSON.stringify(out));

  // ── H. Holidays ────────────────────────────────────────────────────────────────────────────────
  console.log("H. holidays");
  r = await routes.holidays.GET(req(`/api/appointments/availability/holidays`));
  const list = (await body(r))?.holidays ?? [];
  ok("H1 the table's upcoming holidays and eves", r.status === 200 && list.length > 0 && list.every((h: { dayKey: string }) => h.dayKey >= today), String(list.length));
  r = await routes.holidays.POST(req(`/api/appointments/availability/holidays`, { method: "POST", body: { holidays: ["5788:EREV_YOM_KIPPUR", "5788:YOM_KIPPUR"], eveClosingMinute: 780, dryRun: true } }));
  out = await body(r);
  ok("H2 a dry run: 2 days, nothing written", r.status === 200 && out?.created === 2 && (await owner.availabilityException.count({ where: { businessId: bizA, dayKey: { in: [new Date("2027-10-10"), new Date("2027-10-11")] } } })) === 0, JSON.stringify(out));
  r = await routes.holidays.POST(req(`/api/appointments/availability/holidays`, { method: "POST", body: { holidays: ["5788:EREV_YOM_KIPPUR", "5788:YOM_KIPPUR"], eveClosingMinute: 780 } }));
  const hol = await owner.availabilityException.findMany({ where: { businessId: bizA, staffMemberId: null, removedAt: null, dayKey: { in: [new Date("2027-10-10"), new Date("2027-10-11")] } }, orderBy: { dayKey: "asc" } });
  ok("H3 the eve closed 13:00–24:00, Yom Kippur closed all day, named", r.status === 201 && hol.length === 2
    && hol[0].startMinute === 780 && hol[0].endMinute === 1440 && hol[1].startMinute === null && hol[1].label === "יום כיפור", JSON.stringify(hol.map((h) => [h.dayKey, h.startMinute, h.endMinute, h.label])));
  const badH = await Promise.all([
    { holidays: ["5788:XMAS"], eveClosingMinute: 780 },
    { holidays: ["2027-10-11"], eveClosingMinute: 780 },
    { holidays: ["5788:SHAVUOT"], eveClosingMinute: 2000 },
  ].map(async (b) => (await routes.holidays.POST(req(`/api/appointments/availability/holidays`, { method: "POST", body: b }))).status));
  ok("H4 a date or an unknown id is never accepted (400)", badH.every((c) => c === 400), badH.join(","));
  r = await routes.holidays.POST(req(`/api/appointments/availability/holidays`, { method: "POST", token: tokenB, body: { holidays: ["5788:YOM_KIPPUR"], eveClosingMinute: 780, staffMemberId: staffA.id } }));
  ok("H5 B cannot close holidays for A's staff member (404)", r.status === 404, String(r.status));

  // ── Q9. The search limit (last: it spends the user's budget) ──────────────────────────────────
  let limited = 0;
  for (let i = 0; i < 70 && !limited; i++) {
    const x = await routes.search.GET(req(`/api/appointments/search?q=abc`));
    if (x.status === 429) limited = i + 1;
  }
  ok("Q9 the search is rate-limited per user (429 within the 60/min budget + earlier calls)", limited > 0 && limited <= 61, String(limited));

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
