/**
 * Appointments — engine correctness (2026-11-24: G17, G19, G20, G21, G22), end to end on the Production-shaped lab
 * (.bkg/lab.sh <db> --with-bkg: the appointments + public booking migrations applied by migrate deploy; the app AS
 * app_runtime_prod, NOSUPERUSER NOBYPASSRLS). The real route handlers, owner (signed session) and public (no session).
 * Nothing is mocked. No schema change is involved.
 *
 *   N. G17 a night across midnight: business hours Tue 20:00–24:00 + Wed 00:00–02:00 (two rules). A 120-minute service
 *      is offered at 23:00 to the owner and on the public link; the customer books it (AUTO) → 23:00–01:00, one row;
 *      the same time again is refused; the owner cannot book over it in that lane (SLOT_CONFLICT); another lane books
 *      the same night with no "outside the hours" warning, and 4 hours from 23:00 is warned (OUTSIDE_AVAILABILITY).
 *      Twelve simultaneous public submits of one night slot → exactly one; the database holds one.
 *   S. G21 special days per lane: a staff member's own Thursday 10:00–16:00 under the business's special Thursday
 *      08:00–13:00 → 10:00–12:30 only (not 08:00); their own closure touches only their lane; a business closure
 *      closes them. G20: the special day's answer counts the staff appointment it left outside (no cancel).
 *   L. G22 legacy rows: a live row with a start and no end, and one with no start — listed apart ("untimed"); the
 *      start-no-end row blocks its default hour for owner slots, owner writes and the public link; the no-start row is
 *      scheduled through the ordinary move (end from the service), then leaves the list. The conversation route needs
 *      the appointments feature (403 FEATURE_NOT_AVAILABLE) as well as the Inbox.
 *   P. G19 the profile's opening hours: one call writes the calendar's hours as Hebrew text; without a profile row,
 *      nothing is written. G20 on a policy save: the answer carries the count.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 * Run: npx tsx .appt/engine-correctness-battery.ts
 */
process.env.AUTH_TOKEN_SECRET = "appt-ec-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = "appt-ec-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.CRON_SECRET = "appt-ec-synthetic-cron-secret-0123456789abcdef";
process.env.FEATURE_ACCESS_ENFORCEMENT = "enforce";

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
  const routes = {
    pubSlots: await import("@/app/api/public/booking/[publicId]/slots/route"),
    submit: await import("@/app/api/public/booking/[publicId]/requests/route"),
    settings: await import("@/app/api/appointments/booking/settings/route"),
    root: await import("@/app/api/appointments/route"),
    reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
    slots: await import("@/app/api/appointments/slots/route"),
    staff: await import("@/app/api/appointments/staff/route"),
    staffOne: await import("@/app/api/appointments/staff/[staffId]/route"),
    staffServices: await import("@/app/api/appointments/staff/[staffId]/services/route"),
    availability: await import("@/app/api/appointments/availability/route"),
    exceptions: await import("@/app/api/appointments/availability/exceptions/route"),
    profileHours: await import("@/app/api/appointments/availability/profile-hours/route"),
    policy: await import("@/app/api/appointments/services/[serviceId]/policy/route"),
    conversation: await import("@/app/api/conversations/[id]/appointment/route"),
  };

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
  const tag = `appt-ec-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: `${tag}-A` } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  const svc = async (biz: number, name: string, durationMinutes: number) => (await owner.businessService.create({ data: { businessId: biz, name, type: "SERVICE", durationMinutes } })).id;
  const night = await svc(bizA, "ערב ארוך", 120);
  const haircut = await svc(bizA, "תספורת", 30);
  const tokenA = signAuthToken(userA, 0);
  const tokenB = signAuthToken(userB, 0);

  const BASE = "https://app.example.com";
  let ipSeq = 1;
  type Init = { method?: string; body?: unknown; key?: string | null; token?: string | null };
  const req = (path: string, init: Init = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.7.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}` };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const own = (path: string, init: Init = {}) => req(path, { ...init, token: init.token === undefined ? tokenA : init.token });
  const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
  const body = async (r: Response) => { try { return await r.clone().json(); } catch { return null; } };
  const key = () => uuidV7(new Date());

  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { weekdayOf } = await import("@/lib/services/appointment/availability.core");
  let SUN = addCalendarDays(jerusalemDayKey(new Date()), 21);
  while (weekdayOf(SUN) !== 0) SUN = addCalendarDays(SUN, 1);
  const MON = addCalendarDays(SUN, 1), TUE = addCalendarDays(SUN, 2), WED = addCalendarDays(SUN, 3), THU = addCalendarDays(SUN, 4);
  const at = (hhmm: string, day = SUN) => { const [h, m] = hhmm.split(":").map(Number); return jerusalemInstantAt(day, h, m).toISOString(); };
  console.log(`  (the week of ${SUN})`);

  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "public_booking", state: "ENABLED", reason: "lab" } });
  // Warm-up (a slow lab machine): the first call of each route compiles its modules inside the tenant transaction
  // and can outlive the transaction's 5-second limit. Read-only calls, results ignored.
  for (let i = 0; i < 2; i++) {
    await routes.staff.GET(own("/api/appointments/staff")).catch(() => null);
    await routes.availability.GET(own("/api/appointments/availability")).catch(() => null);
    await routes.root.GET(own(`/api/appointments?from=${at("00:00")}&to=${at("23:00")}`)).catch(() => null);
    await routes.slots.GET(own(`/api/appointments/slots?fromDay=${SUN}&toDay=${SUN}&durationMinutes=30`)).catch(() => null);
    await routes.settings.GET(own("/api/appointments/booking/settings")).catch(() => null);
  }
  const mkStaff = async (displayName: string) => (await body(await routes.staff.POST(own("/api/appointments/staff", { method: "POST", body: { displayName } }))))?.staffMember as { id: number };
  const dana = await mkStaff("דנה"), yossi = await mkStaff("יוסי"), ron = await mkStaff("רון"), avi = await mkStaff("אבי");
  const assign = (s: { id: number }, ids: number[]) => routes.staffServices.PUT(own(`/api/appointments/staff/${s.id}/services`, { method: "PUT", body: { services: ids.map((businessServiceId) => ({ businessServiceId })) } }), p({ staffId: String(s.id) }));
  await assign(dana, [night]);
  await assign(yossi, [night, haircut]);
  await assign(ron, [haircut]);
  await assign(avi, [night, haircut]);
  const v = async (id: number) => (await owner.staffMember.findUniqueOrThrow({ where: { id } })).version;
  for (const s of [dana, yossi]) await routes.staffOne.PATCH(own(`/api/appointments/staff/${s.id}`, { method: "PATCH", body: { publicBookable: true, expectedVersion: await v(s.id) } }), p({ staffId: String(s.id) }));
  // Business: Sun–Thu 09:00–17:00, plus the night Tue 20:00–24:00 + Wed 00:00–02:00 (two rules — how the editor saves "until 02:00 the next day").
  const weekly = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }))
    .concat([{ weekday: 2, startMinute: 1200, endMinute: 1440 }, { weekday: 3, startMinute: 0, endMinute: 120 }]);
  let r = await routes.availability.PUT(own("/api/appointments/availability", { method: "PUT", body: { rules: weekly } }));
  const put = await body(r);
  ok("N0 the hours with a night are saved as stated (7 rules), and the answer carries the impact count (G20)", r.status === 200 && put?.rules?.length === 7 && put?.impact?.count === 0, JSON.stringify(put?.impact));
  r = await routes.availability.PUT(own("/api/appointments/availability", { method: "PUT", body: { rules: [{ weekday: 2, startMinute: 1200, endMinute: 1560 }] } }));
  ok("N0b one rule that crosses midnight is refused (400) — never stored or silently dropped", r.status === 400
    && (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${bizA} AND "removedAt" IS NULL`)) === 7, String(r.status));
  const policy = (sid: number, b: Record<string, unknown>) => routes.policy.PUT(own(`/api/appointments/services/${sid}/policy`, { method: "PUT", body: b }), p({ serviceId: String(sid) }));
  await policy(night, { publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 60, maxAdvanceDays: 60 });
  r = await policy(haircut, { publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 30, maxAdvanceDays: 60 });
  ok("P1 a policy save answers with the impact count (G20)", r.status === 200 && typeof (await body(r))?.impact?.count === "number");
  r = await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL" } }));
  const publicId: string = (await body(r))?.settings?.publicId;
  ok("setup: the booking link is on", r.status === 200 && typeof publicId === "string", String(r.status));

  const pubSlots = async (q: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, x]) => [k, String(x)]));
    const res = await routes.pubSlots.GET(req(`/api/public/booking/${publicId}/slots?${qs}`), p({ publicId }));
    return { status: res.status, starts: ((await body(res))?.slots ?? []).map((x: { startsAt: string }) => x.startsAt) as string[] };
  };
  const ownerSlots = async (q: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, x]) => [k, String(x)]));
    const res = await routes.slots.GET(own(`/api/appointments/slots?${qs}`));
    return { status: res.status, starts: ((await body(res))?.slots ?? []).map((x: { startsAt: string }) => x.startsAt) as string[] };
  };
  let phoneSeq = 2000000;
  const submit = (b: Record<string, unknown>, k: string = key()) =>
    routes.submit.POST(req(`/api/public/booking/${publicId}/requests`, { method: "POST", key: k, body: { name: "לקוח לילה", phone: `05${(phoneSeq++).toString().padStart(8, "0")}`, ...b } }), p({ publicId }));
  const create = (b: Record<string, unknown>) => routes.root.POST(own("/api/appointments", { method: "POST", key: key(), body: b }));

  // ── N. G17 — a night across midnight ───────────────────────────────────────────────────────────
  console.log("N. a night across midnight (G17)");
  let os = await ownerSlots({ fromDay: TUE, toDay: TUE, businessServiceId: night, staffMemberId: dana.id });
  ok("N1 owner: the 120-minute service is offered on Tuesday at 23:00 (it ends 01:00 Wednesday)", os.status === 200 && os.starts.includes(at("23:00", TUE)), JSON.stringify(os.starts.slice(-4)));
  ok("N2 owner: …and at 00:00 Wednesday only from Wednesday's side (never past 02:00)", !os.starts.includes(at("00:30", WED)) && !(await ownerSlots({ fromDay: WED, toDay: WED, businessServiceId: night, staffMemberId: dana.id })).starts.includes(at("00:30", WED)));
  let ps = await pubSlots({ serviceId: night, staffId: dana.id, fromDay: TUE, toDay: TUE });
  ok("N3 public link: 23:00 Tuesday is offered", ps.status === 200 && ps.starts.includes(at("23:00", TUE)), JSON.stringify(ps.starts));
  r = await submit({ serviceId: night, staffId: dana.id, startsAt: at("23:00", TUE) });
  const sub = await body(r);
  const nightRow = await owner.appointment.findFirst({ where: { businessId: bizA, sourceChannel: "PUBLIC_BOOKING", startsAt: new Date(at("23:00", TUE)) } });
  ok("N4 the customer books it: 201, one appointment 23:00 Tue → 01:00 Wed in Dana's lane", r.status === 201 && !!nightRow
    && nightRow.endsAt?.toISOString() === at("01:00", WED) && nightRow.staffMemberId === dana.id, JSON.stringify(sub));
  r = await submit({ serviceId: night, staffId: dana.id, startsAt: at("23:00", TUE) });
  ok("N5 the same night again is refused (not 201), still one row", r.status !== 201
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "staffMemberId" = ${dana.id} AND status IN ('PROPOSED','CONFIRMED')`)) === 1, String(r.status));
  ps = await pubSlots({ serviceId: night, staffId: dana.id, fromDay: TUE, toDay: TUE });
  ok("N6 …and is no longer offered (nor 22:00, which would run into it)", !ps.starts.includes(at("23:00", TUE)) && !ps.starts.includes(at("22:00", TUE)), JSON.stringify(ps.starts));
  r = await create({ businessServiceId: night, staffMemberId: dana.id, startsAt: at("00:30", WED), durationMinutes: 60 });
  ok("N7 the owner cannot book over it after midnight in that lane (409 SLOT_CONFLICT naming it)", r.status === 409 && (await body(r))?.details?.conflictingAppointmentIds?.includes(nightRow?.id), String(r.status));
  r = await create({ businessServiceId: night, staffMemberId: yossi.id, startsAt: at("23:00", TUE) });
  const y = await body(r);
  ok("N8 another lane books the same night: 201 with NO outside-the-hours warning (inside across midnight)", r.status === 201 && Array.isArray(y?.warnings) && y.warnings.length === 0, JSON.stringify(y?.warnings));
  r = await create({ businessServiceId: night, staffMemberId: avi.id, startsAt: at("23:00", TUE), durationMinutes: 240 });
  ok("N9 four hours from 23:00 runs past 02:00: created, and warned OUTSIDE_AVAILABILITY (the owner's call)", r.status === 201 && (await body(r))?.warnings?.includes("OUTSIDE_AVAILABILITY"));
  // Concurrency: twelve public submits of one night slot (Dana, 20:00 Tue) at once → exactly one.
  const race = await Promise.all(Array.from({ length: 12 }, () => submit({ serviceId: night, staffId: dana.id, startsAt: at("20:00", TUE) })));
  ok("N10 twelve simultaneous submits of one slot → exactly one 201, no 500", race.filter((x) => x.status === 201).length === 1 && race.every((x) => x.status < 500), race.map((x) => x.status).join(","));
  ok("N11 …the database holds exactly one live appointment at that time in that lane", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "staffMemberId" = ${dana.id} AND "startsAt" = '${at("20:00", TUE).replace("T", " ").replace("Z", "")}' AND status IN ('PROPOSED','CONFIRMED')`)) === 1);
  ok("N12 no two live timed appointments of one lane overlap anywhere (the constraint's own predicate)", (await n(`SELECT count(*)::int AS n FROM "Appointment" a JOIN "Appointment" b ON a."businessId" = b."businessId" AND COALESCE(a."staffMemberId",0) = COALESCE(b."staffMemberId",0) AND a.id < b.id
      WHERE a."businessId" = ${bizA} AND a.status IN ('PROPOSED','CONFIRMED') AND b.status IN ('PROPOSED','CONFIRMED') AND a."endsAt" IS NOT NULL AND b."endsAt" IS NOT NULL
      AND tsrange(a."startsAt" - a."bufferBeforeMinutes" * interval '1 minute', a."endsAt" + a."bufferAfterMinutes" * interval '1 minute', '[)') && tsrange(b."startsAt" - b."bufferBeforeMinutes" * interval '1 minute', b."endsAt" + b."bufferAfterMinutes" * interval '1 minute', '[)')`)) === 0);

  // ── S. G21 — special days per lane; G20 — the impact ─────────────────────────────────────────────
  console.log("S. special days per lane (G21) and the impact (G20)");
  r = await routes.availability.PUT(own("/api/appointments/availability", { method: "PUT", body: { staffMemberId: ron.id, rules: [1, 4].map((weekday) => ({ weekday, startMinute: 600, endMinute: 960 })) } }));
  ok("S0 Ron's own hours: Mon + Thu 10:00–16:00", r.status === 200);
  r = await create({ businessServiceId: haircut, staffMemberId: ron.id, startsAt: at("14:00", THU) });
  const ronAppt = (await body(r))?.appointment?.id as number;
  ok("S1 Ron has an appointment Thu 14:00 (inside his hours)", r.status === 201 && (await body(r))?.warnings?.length === 0);
  r = await routes.exceptions.POST(own("/api/appointments/availability/exceptions", { method: "POST", body: { dayKey: THU, kind: "OPEN_HOURS", startMinute: 480, endMinute: 780, label: "יום קצר" } }));
  const ex = await body(r);
  ok("S2 the business's special Thursday 08:00–13:00: 201, and the answer counts the appointment it left outside, with its day (G20; Avi's 4-hour night from N9 counts too)", r.status === 201
    && ex?.impact?.count >= 1 && ex.impact.days?.some((d: { dayKey: string }) => d.dayKey === THU) && ex.impact.firstIds?.includes(ronAppt), JSON.stringify(ex?.impact));
  ok("S3 …nothing is cancelled or moved", (await owner.appointment.findUniqueOrThrow({ where: { id: ronAppt } })).status === "CONFIRMED");
  os = await ownerSlots({ fromDay: THU, toDay: THU, businessServiceId: haircut, staffMemberId: ron.id });
  ok("S4 Ron's Thursday: his own 10:00–16:00 bounded by the business's 08:00–13:00 → 10:00…12:30 (not from 08:00)", os.starts[0] === at("10:00", THU) && os.starts.at(-1) === at("12:30", THU) && !os.starts.includes(at("08:00", THU)), JSON.stringify(os.starts));
  os = await ownerSlots({ fromDay: THU, toDay: THU, businessServiceId: haircut });
  ok("S5 the business lane that Thursday: 08:00…12:30", os.starts[0] === at("08:00", THU) && os.starts.at(-1) === at("12:30", THU), JSON.stringify([os.starts[0], os.starts.at(-1)]));
  r = await routes.exceptions.POST(own("/api/appointments/availability/exceptions", { method: "POST", body: { staffMemberId: ron.id, dayKey: THU, kind: "CLOSED", startMinute: 660, endMinute: 720 } }));
  os = await ownerSlots({ fromDay: THU, toDay: THU, businessServiceId: haircut, staffMemberId: ron.id });
  const bizThu = await ownerSlots({ fromDay: THU, toDay: THU, businessServiceId: haircut });
  ok("S6 Ron's own closure 11:00–12:00 cuts only his lane", r.status === 201 && !os.starts.includes(at("11:00", THU)) && bizThu.starts.includes(at("11:00", THU)));
  await routes.exceptions.POST(own("/api/appointments/availability/exceptions", { method: "POST", body: { dayKey: MON, kind: "CLOSED", label: "חג" } }));
  ok("S7 a business closure (Monday) closes Ron's own Monday too", (await ownerSlots({ fromDay: MON, toDay: MON, businessServiceId: haircut, staffMemberId: ron.id })).starts.length === 0);
  ok("S8 on an ordinary weekday Ron's own hours stand (owner's calendar): Thu next week from 10:00", (await ownerSlots({ fromDay: addCalendarDays(THU, 7), toDay: addCalendarDays(THU, 7), businessServiceId: haircut, staffMemberId: ron.id })).starts[0] === at("10:00", addCalendarDays(THU, 7)));

  // ── L. G22 — legacy rows ─────────────────────────────────────────────────────────────────────────
  console.log("L. appointments without a time or an end (G22)");
  const legacyEndless = await owner.appointment.create({ data: { businessId: bizA, status: "CONFIRMED", startsAt: new Date(at("10:00", WED)), createdByActor: "OWNER", sourceChannel: "INBOX_WEB", createdByUserId: userA, title: "ישן" } });
  const legacyNoStart = await owner.appointment.create({ data: { businessId: bizA, status: "PROPOSED", createdByActor: "BOT", sourceChannel: "INBOX_WEB", businessServiceId: haircut, title: "משיחה" } });
  r = await routes.root.GET(own(`/api/appointments?from=${at("00:00", SUN)}&to=${at("00:00", addCalendarDays(SUN, 7))}`));
  const listed = await body(r);
  const untimedIds = (listed?.untimed ?? []).map((a: { id: number }) => a.id);
  ok("L1 the calendar read lists both apart as untimed (ללא שעה)", r.status === 200 && untimedIds.includes(legacyEndless.id) && untimedIds.includes(legacyNoStart.id), JSON.stringify(untimedIds));
  os = await ownerSlots({ fromDay: WED, toDay: WED, businessServiceId: haircut });
  ok("L2 owner slots: the start-without-end row takes its default hour (no 10:00 / 10:30 in the business lane)", os.starts.length > 0 && !os.starts.includes(at("10:00", WED)) && !os.starts.includes(at("10:30", WED)) && os.starts.includes(at("11:00", WED)), JSON.stringify(os.starts.slice(0, 6)));
  r = await create({ businessServiceId: haircut, startsAt: at("10:30", WED) });
  ok("L3 the owner cannot book over it (409 SLOT_CONFLICT naming it)", r.status === 409 && (await body(r))?.details?.conflictingAppointmentIds?.includes(legacyEndless.id), String(r.status));
  ps = await pubSlots({ serviceId: haircut, fromDay: WED, toDay: WED });
  ok("L4 public link: 10:00 and 10:30 are not offered", ps.status === 200 && ps.starts.length > 0 && !ps.starts.includes(at("10:00", WED)) && !ps.starts.includes(at("10:30", WED)), JSON.stringify(ps.starts.slice(0, 6)));
  r = await submit({ serviceId: haircut, startsAt: at("10:30", WED) });
  ok("L5 public submit over it is refused, nothing written", r.status !== 201 && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("10:30", WED).replace("T", " ").replace("Z", "")}'`)) === 0, String(r.status));
  r = await routes.reschedule.POST(own(`/api/appointments/${legacyNoStart.id}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("15:00", WED), expectedVersion: legacyNoStart.version } }), p({ id: String(legacyNoStart.id) }));
  const moved = await owner.appointment.findUniqueOrThrow({ where: { id: legacyNoStart.id } });
  ok("L6 the no-start row is scheduled by the ordinary move: an end from its service (30 min), journalled", r.status === 200 && moved.startsAt?.toISOString() === at("15:00", WED) && moved.endsAt?.toISOString() === at("15:30", WED)
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${legacyNoStart.id} AND "eventType" = 'APPOINTMENT_RESCHEDULED'`)) === 1, `${r.status} ${JSON.stringify(await body(r))}`);
  r = await routes.reschedule.POST(own(`/api/appointments/${legacyEndless.id}/reschedule`, { method: "POST", key: key(), body: { startsAt: at("15:00", WED), expectedVersion: legacyEndless.version } }), p({ id: String(legacyEndless.id) }));
  ok("L7 …and a move onto it is refused under the same lock (409)", r.status === 409, String(r.status));
  r = await routes.root.GET(own(`/api/appointments?from=${at("00:00", SUN)}&to=${at("00:00", addCalendarDays(SUN, 7))}`));
  const after = ((await body(r))?.untimed ?? []).map((a: { id: number }) => a.id);
  ok("L8 once timed it leaves the untimed list; the end-less one stays", !after.includes(legacyNoStart.id) && after.includes(legacyEndless.id));
  await owner.businessFeatureAccess.create({ data: { businessId: bizB, featureKey: "inbox", state: "ENABLED", reason: "lab" } });
  await owner.businessFeatureAccess.create({ data: { businessId: bizB, featureKey: "appointments", state: "DISABLED", reason: "lab" } });
  r = await routes.conversation.POST(req("/api/conversations/999999/appointment", { method: "POST", token: tokenB, body: {} }), p({ id: "999999" }));
  ok("L9 the conversation route refuses a business without appointments (404, as every appointments route)", r.status === 404 && (await body(r))?.error === "Not found", `${r.status} ${JSON.stringify(await body(r))}`);
  // A business with both features on (its own: feature answers are cached per business for a short while).
  const bizC = (await owner.business.create({ data: { name: `${tag}-C` } })).id;
  const tokenC = signAuthToken((await owner.user.create({ data: { email: `${tag}-c@lab.test`, password: "x", businessId: bizC } })).id, 0);
  for (const featureKey of ["inbox", "appointments"]) await owner.businessFeatureAccess.create({ data: { businessId: bizC, featureKey, state: "ENABLED", reason: "lab" } });
  r = await routes.conversation.POST(req("/api/conversations/999999/appointment", { method: "POST", token: tokenC, body: {} }), p({ id: "999999" }));
  ok("L10 …with both features on, it reaches its own answer (404 conversation_not_found)", r.status === 404 && (await body(r))?.error === "conversation_not_found", `${r.status} ${JSON.stringify(await body(r))}`);

  // ── P. G19 — the profile's opening hours ─────────────────────────────────────────────────────────
  console.log("P. the profile's opening hours (G19)");
  r = await routes.profileHours.POST(own("/api/appointments/availability/profile-hours", { method: "POST", body: {} }));
  ok("P2 without a profile row nothing is written (updated: false)", r.status === 200 && (await body(r))?.updated === false
    && (await n(`SELECT count(*)::int AS n FROM "BusinessProfile" WHERE "businessId" = ${bizA}`)) === 0, JSON.stringify(await body(r)));
  await owner.businessProfile.create({ data: { businessId: bizA, openingHours: "טקסט ישן" } });
  r = await routes.profileHours.POST(own("/api/appointments/availability/profile-hours", { method: "POST", body: {} }));
  const prof = await owner.businessProfile.findUniqueOrThrow({ where: { businessId: bizA } });
  ok("P3 with one, the calendar's hours are written as Hebrew text built on the server", r.status === 200 && (await body(r))?.updated === true
    && prof.openingHours === "ראשון–שני 09:00–17:00 · שלישי 09:00–17:00, 20:00–02:00 · רביעי–חמישי 09:00–17:00 · שישי–שבת סגור", String(prof.openingHours));
  const profC = await routes.profileHours.POST(own("/api/appointments/availability/profile-hours", { method: "POST", body: {}, token: tokenC }));
  ok("P4 another business's call (no hours, no profile) writes nothing and never touches A's profile", profC.status === 200 && (await body(profC))?.updated === false && (await owner.businessProfile.findUniqueOrThrow({ where: { businessId: bizA } })).openingHours === prof.openingHours);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
