/**
 * Appointments milestone B follow-ups — the three owner-approved API additions, end to end AS the restricted runtime
 * (DATABASE_URL = app_runtime_prod, NOSUPERUSER NOBYPASSRLS) on the Production-shaped lab (.appt/lab.sh --with-appt).
 * The real route handlers are called with real signed session tokens; the owner connection only builds fixtures and
 * reads back.
 *
 *   S. PATCH /api/business/services/[id] — the owner edits a service's name and length; another business's service,
 *      a product, a missing id → 404 and nothing changes; bad input → 400; no session → 401; the price and status are
 *      never touched (extra fields are ignored); POST still creates.
 *   L. GET /api/leads?customerId= — only that customer's OPEN leads, also among the "urgent" candidates the route
 *      merges in; another business's customer id → nothing; a bad id → 400; without it the list is unchanged; no lead
 *      stage changes.
 *   N. GET /api/appointments (and /[id]) carry the customer's name from ONE extra query, scoped to the business: a
 *      customer outside any "recent" window is named; another business sees only its own; 400 appointments with 400
 *      customers answer within the budget.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 */
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "appt-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "appt-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";
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

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const routes = {
    services: await import("@/app/api/business/services/route"),
    service: await import("@/app/api/business/services/[id]/route"),
    leads: await import("@/app/api/leads/route"),
    appointments: await import("@/app/api/appointments/route"),
    appointment: await import("@/app/api/appointments/[id]/route"),
  };

  const tag = `appt-b2-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: `${tag}-A` } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  await owner.businessFeatureAccess.create({ data: { businessId: bizB, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  const tokenA = signAuthToken(userA, 0);
  const tokenB = signAuthToken(userB, 0);

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

  // ── S. Services ────────────────────────────────────────────────────────────────────────────────
  console.log("S. PATCH /api/business/services/[id]");
  const svcA = await owner.businessService.create({ data: { businessId: bizA, name: "תספורת", type: "SERVICE", durationMinutes: 45, priceMode: "FIXED", priceAmount: 120 } });
  const svcB = await owner.businessService.create({ data: { businessId: bizB, name: "עיסוי", type: "SERVICE", durationMinutes: 60 } });
  const prodA = await owner.businessService.create({ data: { businessId: bizA, name: "שמפו", type: "PRODUCT" } });

  let r = await routes.service.PATCH(req(`/api/business/services/${svcA.id}`, { method: "PATCH", body: { durationMinutes: 50, name: "תספורת גברים" } }), p({ id: String(svcA.id) }));
  let row = await owner.businessService.findUniqueOrThrow({ where: { id: svcA.id } });
  ok("S1 the owner changes a service's length and name", r.status === 200 && row.durationMinutes === 50 && row.name === "תספורת גברים", String(r.status));
  r = await routes.service.PATCH(req(`/api/business/services/${svcA.id}`, { method: "PATCH", body: { durationMinutes: 40, priceAmount: 1, priceMode: "QUOTE_REQUIRED", active: false, businessId: bizB } }), p({ id: String(svcA.id) }));
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svcA.id } });
  ok("S2 price, status and business are never edited (extra fields ignored)", r.status === 200 && row.durationMinutes === 40 && String(row.priceAmount) === "120" && row.priceMode === "FIXED" && row.active === true && row.businessId === bizA);
  r = await routes.service.PATCH(req(`/api/business/services/${svcB.id}`, { method: "PATCH", body: { durationMinutes: 5 } }), p({ id: String(svcB.id) }));
  const b = await owner.businessService.findUniqueOrThrow({ where: { id: svcB.id } });
  ok("S3 another business's service: 404, untouched", r.status === 404 && b.durationMinutes === 60, String(r.status));
  r = await routes.service.PATCH(req(`/api/business/services/${prodA.id}`, { method: "PATCH", body: { durationMinutes: 30 } }), p({ id: String(prodA.id) }));
  ok("S4 a product is not a service: 404", r.status === 404, String(r.status));
  r = await routes.service.PATCH(req(`/api/business/services/999999999`, { method: "PATCH", body: { durationMinutes: 30 } }), p({ id: "999999999" }));
  ok("S5 a missing id: 404", r.status === 404, String(r.status));
  const bad = [
    { durationMinutes: 0 }, { durationMinutes: 2000 }, { durationMinutes: 12.5 }, { durationMinutes: "30" }, { name: "" }, { name: "x".repeat(121) }, {},
  ];
  const codes: number[] = [];
  for (const x of bad) codes.push((await routes.service.PATCH(req(`/api/business/services/${svcA.id}`, { method: "PATCH", body: x }), p({ id: String(svcA.id) }))).status);
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svcA.id } });
  ok("S6 bad input → 400 and nothing changes (0, 2000, 12.5, \"30\", empty name, long name, nothing)", codes.every((c) => c === 400) && row.durationMinutes === 40 && row.name === "תספורת גברים", codes.join(","));
  r = await routes.service.PATCH(req(`/api/business/services/${svcA.id}`, { method: "PATCH", body: { durationMinutes: null } }), p({ id: String(svcA.id) }));
  row = await owner.businessService.findUniqueOrThrow({ where: { id: svcA.id } });
  ok("S7 a length can be cleared (the calendar then asks for one per appointment)", r.status === 200 && row.durationMinutes === null);
  r = await routes.service.PATCH(req(`/api/business/services/${svcA.id}`, { method: "PATCH", body: { durationMinutes: 30 }, token: null }), p({ id: String(svcA.id) }));
  ok("S8 no session → 401", r.status === 401, String(r.status));
  r = await routes.services.POST(req(`/api/business/services`, { method: "POST", body: { name: "צבע", durationMinutes: 90, priceMode: "NO_PUBLIC_PRICE" } }));
  const created = (await body(r))?.service;
  ok("S9 POST still creates a service with its length, in this business", r.status === 200 && created?.durationMinutes === 90 && created?.businessId === bizA, String(r.status));

  // ── L. Leads by customer ───────────────────────────────────────────────────────────────────────
  console.log("L. GET /api/leads?customerId=");
  const ron = await owner.customer.create({ data: { businessId: bizA, name: "רון אברהם", phone: "+972524444444" } });
  const dana = await owner.customer.create({ data: { businessId: bizA, name: "דנה", phone: "+972525555555" } });
  const custB = await owner.customer.create({ data: { businessId: bizB, name: "לקוח ב", phone: "+972529999999" } });
  // Ron's open lead has NO phone and another name: the old phone/name search could not find it.
  const ronLead = await owner.lead.create({ data: { businessId: bizA, customerId: ron.id, customerName: "ר. א.", status: "OPEN" } });
  const ronWon = await owner.lead.create({ data: { businessId: bizA, customerId: ron.id, customerName: "רון", status: "WON" } });
  // Dana's lead is "urgent" (follow-up overdue), so the route's urgent candidates would surface it.
  const danaLead = await owner.lead.create({ data: { businessId: bizA, customerId: dana.id, customerName: "דנה", status: "OPEN", nextFollowUpAt: new Date(Date.now() - 3 * 864e5) } });
  const leadB = await owner.lead.create({ data: { businessId: bizB, customerId: custB.id, customerName: "לקוח ב", status: "OPEN" } });
  const stagesBefore = JSON.stringify(await owner.lead.findMany({ where: { id: { in: [ronLead.id, ronWon.id, danaLead.id, leadB.id] } }, select: { id: true, status: true }, orderBy: { id: "asc" } }));

  r = await routes.leads.GET(req(`/api/leads?customerId=${ron.id}`));
  let ids = ((await body(r))?.leads ?? []).map((l: { id: number }) => l.id);
  ok("L1 only that customer's OPEN lead (no phone, another name — found by the customer itself)", r.status === 200 && ids.length === 1 && ids[0] === ronLead.id, JSON.stringify(ids));
  ok("L2 the urgent candidates the route merges in are filtered too (Dana's overdue lead is not there)", !ids.includes(danaLead.id));
  r = await routes.leads.GET(req(`/api/leads?customerId=${custB.id}`));
  ids = ((await body(r))?.leads ?? []).map((l: { id: number }) => l.id);
  ok("L3 another business's customer id → nothing", r.status === 200 && ids.length === 0, JSON.stringify(ids));
  r = await routes.leads.GET(req(`/api/leads?customerId=${ron.id}`, { token: tokenB }));
  ids = ((await body(r))?.leads ?? []).map((l: { id: number }) => l.id);
  ok("L4 business B asking for A's customer → nothing of A", r.status === 200 && ids.length === 0, JSON.stringify(ids));
  const badLead = await Promise.all(["0", "-3", "abc", "1.5"].map(async (v) => (await routes.leads.GET(req(`/api/leads?customerId=${v}`))).status));
  ok("L5 a bad customerId → 400", badLead.every((s) => s === 400), badLead.join(","));
  r = await routes.leads.GET(req(`/api/leads`));
  ids = ((await body(r))?.leads ?? []).map((l: { id: number }) => l.id).sort((a: number, b: number) => a - b);
  ok("L6 without it the list is unchanged: every open lead of the business", r.status === 200 && JSON.stringify(ids) === JSON.stringify([ronLead.id, danaLead.id].sort((a, b) => a - b)), JSON.stringify(ids));
  const stagesAfter = JSON.stringify(await owner.lead.findMany({ where: { id: { in: [ronLead.id, ronWon.id, danaLead.id, leadB.id] } }, select: { id: true, status: true }, orderBy: { id: "asc" } }));
  ok("L7 no lead stage changed", stagesBefore === stagesAfter);

  // ── N. Customer names on the calendar ──────────────────────────────────────────────────────────
  console.log("N. customer names in GET /api/appointments");
  const principalA = { kind: "OWNER" as const, businessId: bizA, userId: userA };
  const principalB = { kind: "OWNER" as const, businessId: bizB, userId: userB };
  const day = addCalendarDays(jerusalemDayKey(new Date()), 3);
  const old = await owner.customer.create({ data: { businessId: bizA, name: "לקוחה ותיקה" } });
  // 150 newer customers push "לקוחה ותיקה" far outside any "recent 100" list.
  await owner.customer.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ businessId: bizA, name: `לקוח ${i}` })) });
  const book = (principal: typeof principalA, input: Record<string, unknown>) => schedule.createAppointment(principal, { idempotencyKey: uuidV7(new Date()) }, input);
  const a1 = (await book(principalA, { startsAt: jerusalemInstantAt(day, 9, 0).toISOString(), durationMinutes: 30, customerId: old.id })).appointment;
  const a2 = (await book(principalA, { kind: "INTERNAL", title: "ישיבה", startsAt: jerusalemInstantAt(day, 10, 0).toISOString(), durationMinutes: 30 })).appointment;
  const b1 = (await book(principalB, { startsAt: jerusalemInstantAt(day, 9, 0).toISOString(), durationMinutes: 30, customerId: custB.id })).appointment;
  const range = `from=${encodeURIComponent(jerusalemInstantAt(day, 0, 0).toISOString())}&to=${encodeURIComponent(jerusalemInstantAt(addCalendarDays(day, 1), 0, 0).toISOString())}`;
  r = await routes.appointments.GET(req(`/api/appointments?${range}`));
  let list = (await body(r))?.appointments ?? [];
  const x1 = list.find((a: { id: number }) => a.id === a1.id);
  const x2 = list.find((a: { id: number }) => a.id === a2.id);
  ok("N1 a customer outside any recent window is named from the same read", r.status === 200 && x1?.customerName === "לקוחה ותיקה", JSON.stringify(x1?.customerName));
  ok("N2 an appointment without a customer has customerName null", x2 && x2.customerName === null);
  ok("N3 business A's list holds only A's appointments", list.every((a: { businessId: number }) => a.businessId === bizA) && !list.some((a: { id: number }) => a.id === b1.id));
  r = await routes.appointments.GET(req(`/api/appointments?${range}`, { token: tokenB }));
  list = (await body(r))?.appointments ?? [];
  ok("N4 business B sees its own customer's name and nothing of A", r.status === 200 && list.length === 1 && list[0].id === b1.id && list[0].customerName === "לקוח ב", JSON.stringify(list.map((a: { id: number; customerName: string }) => [a.id, a.customerName])));
  r = await routes.appointment.GET(req(`/api/appointments/${a1.id}`), p({ id: String(a1.id) }));
  ok("N5 one appointment carries its customer's name too", r.status === 200 && (await body(r))?.appointment?.customerName === "לקוחה ותיקה", String(r.status));
  r = await routes.appointment.GET(req(`/api/appointments/${a1.id}`, { token: tokenB }), p({ id: String(a1.id) }));
  ok("N6 business B cannot open A's appointment (404, no name)", r.status === 404, String(r.status));

  // Performance: a busy month — 400 appointments, 400 different customers — in one read.
  const perfDay = addCalendarDays(day, 10);
  const many = await owner.customer.createManyAndReturn({ data: Array.from({ length: 400 }, (_, i) => ({ businessId: bizA, name: `עומס ${i}` })), select: { id: true } });
  await owner.appointment.createMany({
    data: many.map((c, i) => {
      const start = jerusalemInstantAt(addCalendarDays(perfDay, Math.floor(i / 20)), 8 + Math.floor((i % 20) / 2), (i % 2) * 30);
      return {
        businessId: bizA, kind: "CUSTOMER" as const, status: "CONFIRMED" as const, startsAt: start, endsAt: new Date(start.getTime() + 15 * 60_000), durationMinutes: 15,
        customerId: c.id, createdByActor: "OWNER" as const, createdByUserId: userA, sourceChannel: "INBOX_WEB" as const, staffMemberId: null,
      };
    }),
  });
  const perfRange = `from=${encodeURIComponent(jerusalemInstantAt(perfDay, 0, 0).toISOString())}&to=${encodeURIComponent(jerusalemInstantAt(addCalendarDays(perfDay, 21), 0, 0).toISOString())}`;
  await routes.appointments.GET(req(`/api/appointments?${perfRange}`)); // warm
  const t0 = Date.now();
  r = await routes.appointments.GET(req(`/api/appointments?${perfRange}`));
  const ms = Date.now() - t0;
  list = (await body(r))?.appointments ?? [];
  ok(`N7 400 appointments with 400 customers, every one named, in one read (${ms} ms, budget 2000)`, r.status === 200 && list.length === 400 && list.every((a: { customerName: string | null }) => typeof a.customerName === "string" && a.customerName.startsWith("עומס")) && ms < 2000, `${list.length} rows, ${ms} ms`);

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
