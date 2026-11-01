/**
 * Milestone C, segments 1–2 — the APPLICATION, end to end, on the Production-shaped lab (.bkg/lab.sh --with-bkg):
 * tenant plane DATABASE_URL = app_runtime_prod (NOSUPERUSER NOBYPASSRLS), owner (OWNER_URL) for fixtures and
 * read-back. The real route handlers — public (no session) and the owner's (signed session tokens). Nothing is mocked.
 *
 *   A. Closed by default: while public_booking is OFF the link cannot be turned on or replaced (409 BOOKING_CLOSED) and
 *      no link is shown. The door: 404 while public_booking is OFF, the business's switch is off, the link is unknown or
 *      malformed, or the emergency switch is set — the same body every time. Open: only what the business publishes.
 *   B. Free times: hours, a closed day, a part-day closure, a business-wide block, staff not public / not assigned,
 *      services not public, the horizon, the past.
 *   C. Submit: a pending request holds its time (12 h), journalled as the customer, a demand signal, the owner's
 *      notification, a manage token stored as a hash; replay; key reuse; every bypass attempt through the API refused
 *      (closed, blocked, off-hours, off-step, too far, past, not public, wrong staff); honeypot and contact checks;
 *      the per-phone cap (platform and business); an automatic service; no hint about a known phone.
 *   D. Concurrency: ten requests for one slot → exactly one; two staff at the same hour → both.
 *   E. Assignment: balanced and priority; staff choice NONE / REQUIRED; a staff member taken off the link keeps their
 *      appointments.
 *   F. The owner decides: approve, again (refused), decline (the time is free), cancel from the calendar settles the
 *      request, DECLINED only for a public request, approve just before and just after the expiry.
 *   G. Expiry: the sweeper and the lazy path release the time; journalled as the system.
 *   H. Reminders: two-hourly, one claim per window even with repeated sweeps, none after a decision; quiet hours (none
 *      22:00–08:00, exactly one at 08:00, no duplicate, expiry unchanged, none after it lapsed); the sweep route's auth.
 *   I. Linking the customer (D6): never automatic; to the match, or a new card; never a second card for a phone.
 *   J. The customer's link: view, withdraw, the self-cancel window and switch, a garbage token, the flag OFF.
 *   K. Isolation: another business sees and decides nothing of A's; A's link cannot use B's services.
 *   L. Settings: the platform ceiling, a new link (the old one stops), the business's switch.
 *   M. Abuse: the IP limit, a limiter outage (503, nothing written — fail closed), JSON only.
 *   N. Regression: the calendar lists public appointments with their request; the owner's own exception (booking in a
 *      closed time with a warning) is untouched.
 *   O. The business's hours bound the link (owner decision 2026-10-28): a staff member's own hours only narrow them —
 *      the service's length, a closure, a closed day, "any staff", the server's refusal; the owner's calendar unchanged.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 */
process.env.AUTH_TOKEN_SECRET = "bkg-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = "bkg-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.CRON_SECRET = "bkg-lab-synthetic-cron-secret-0123456789abcdef";

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
const one = async <T = Record<string, unknown>>(sql: string) => ((await owner.$queryRawUnsafe(sql)) as T[])[0];

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { runBookingSweep } = await import("@/lib/services/booking/booking-sweep.service");
  const { isQuietHours, sha256Hex } = await import("@/lib/services/booking/booking.core");
  const routes = {
    profile: await import("@/app/api/public/booking/[publicId]/route"),
    slots: await import("@/app/api/public/booking/[publicId]/slots/route"),
    submit: await import("@/app/api/public/booking/[publicId]/requests/route"),
    manage: await import("@/app/api/public/booking/manage/route"),
    settings: await import("@/app/api/appointments/booking/settings/route"),
    link: await import("@/app/api/appointments/booking/settings/link/route"),
    requests: await import("@/app/api/appointments/booking/requests/route"),
    request: await import("@/app/api/appointments/booking/requests/[id]/route"),
    sweep: await import("@/app/api/appointments/booking/sweep/route"),
    root: await import("@/app/api/appointments/route"),
    status: await import("@/app/api/appointments/[id]/status/route"),
    staff: await import("@/app/api/appointments/staff/route"),
    staffOne: await import("@/app/api/appointments/staff/[staffId]/route"),
    staffServices: await import("@/app/api/appointments/staff/[staffId]/services/route"),
    availability: await import("@/app/api/appointments/availability/route"),
    exceptions: await import("@/app/api/appointments/availability/exceptions/route"),
    policy: await import("@/app/api/appointments/services/[serviceId]/policy/route"),
  };

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
  const tag = `bkg-app-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: `${tag}-A` } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  const svc = async (biz: number, name: string, durationMinutes: number) => (await owner.businessService.create({ data: { businessId: biz, name, type: "SERVICE", durationMinutes, priceMode: "FIXED", priceAmount: 120 } })).id;
  const haircut = await svc(bizA, "תספורת", 30);
  const color = await svc(bizA, "צבע", 60);
  const consult = await svc(bizA, "ייעוץ", 30);
  const svcB = await svc(bizB, "עיסוי", 45);
  const tokenA = signAuthToken(userA, 0);
  const tokenB = signAuthToken(userB, 0);

  const BASE = "https://app.example.com";
  let ipSeq = 1;
  type Init = { method?: string; body?: unknown; key?: string | null; token?: string | null; ip?: string; contentType?: string | null; bearer?: string };
  const req = (path: string, init: Init = {}) => {
    const headers: Record<string, string> = {};
    if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
    const token = init.token === undefined ? null : init.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.key) headers["idempotency-key"] = init.key;
    headers["x-forwarded-for"] = init.ip ?? `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
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

  // Owner configuration through the owner's own routes.
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  await owner.businessFeatureAccess.create({ data: { businessId: bizB, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  const mkStaff = async (displayName: string) => (await body(await routes.staff.POST(own("/api/appointments/staff", { method: "POST", body: { displayName } }))))?.staffMember;
  const dana = await mkStaff("דנה"), yossi = await mkStaff("יוסי"), avi = await mkStaff("אבי");
  await routes.staffServices.PUT(own(`/api/appointments/staff/${dana.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }, { businessServiceId: color }] } }), p({ staffId: String(dana.id) }));
  await routes.staffServices.PUT(own(`/api/appointments/staff/${yossi.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }] } }), p({ staffId: String(yossi.id) }));
  await routes.staffServices.PUT(own(`/api/appointments/staff/${avi.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }] } }), p({ staffId: String(avi.id) }));
  const staffPatch = async (s: { id: number }, patch: Record<string, unknown>) => {
    const v = (await owner.staffMember.findUniqueOrThrow({ where: { id: s.id } })).version;
    return routes.staffOne.PATCH(own(`/api/appointments/staff/${s.id}`, { method: "PATCH", body: { ...patch, expectedVersion: v } }), p({ staffId: String(s.id) }));
  };
  await staffPatch(dana, { publicBookable: true, sortOrder: 0 });
  await staffPatch(yossi, { publicBookable: true, sortOrder: 1 });
  await staffPatch(avi, { sortOrder: 2 }); // not public
  const weekly = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
  await routes.availability.PUT(own("/api/appointments/availability", { method: "PUT", body: { rules: weekly } }));
  await routes.exceptions.POST(own("/api/appointments/availability/exceptions", { method: "POST", body: { dayKey: MON, kind: "CLOSED", label: "חג" } }));
  await routes.exceptions.POST(own("/api/appointments/availability/exceptions", { method: "POST", body: { dayKey: TUE, kind: "CLOSED", startMinute: 720, endMinute: 840 } }));
  await routes.root.POST(own("/api/appointments", { method: "POST", key: key(), body: { kind: "BLOCK", startsAt: at("10:00", WED), durationMinutes: 60, title: "חסימה" } }));
  const policy = (sid: number, b: Record<string, unknown>) => routes.policy.PUT(own(`/api/appointments/services/${sid}/policy`, { method: "PUT", body: b }), p({ serviceId: String(sid) }));
  await policy(haircut, { publicBookable: true, approvalMode: "MANUAL", slotStepMinutes: 30, maxAdvanceDays: 60 });
  await policy(color, { publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 30, maxAdvanceDays: 60 });
  await policy(consult, { publicBookable: false, slotStepMinutes: 30 });

  // ── A. The door ────────────────────────────────────────────────────────────────────────────────
  console.log("A. the door");
  // Closed by default: while public_booking is OFF the owner can prepare everything, but no link exists or turns on.
  let r = await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL" } }));
  const closedErr = await body(r);
  const closedSettings = await body(await routes.settings.GET(own("/api/appointments/booking/settings")));
  const closedCount = await body(await routes.requests.GET(own("/api/appointments/booking/requests?count=1")));
  ok("A0 public_booking OFF: turning the link on → 409 BOOKING_CLOSED, nothing written; no link shown; the calendar told it is closed",
    r.status === 409 && closedErr?.error === "BOOKING_CLOSED"
    && (await n(`SELECT count(*)::int AS n FROM "BookingSettings" WHERE "businessId" = ${bizA} AND (enabled OR "publicId" IS NOT NULL)`)) === 0
    && closedSettings?.settings?.linkPath === null && closedSettings?.settings?.publicId === null && closedSettings?.platform?.open === false
    && closedCount?.open === false && closedCount?.pending === 0, JSON.stringify({ closedErr, closedCount }));
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "public_booking", state: "ENABLED", reason: "lab" } });
  r = await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL" } }));
  const adm = await body(r);
  const publicId: string = adm?.settings?.publicId;
  ok("A0b ON: the owner turns the link on: an opaque 24-character id, never the business id or name; the link is shown", r.status === 200 && /^[A-Za-z0-9_-]{24}$/.test(publicId ?? "") && publicId !== String(bizA) && !/^\d+$/.test(publicId) && !publicId.includes(tag)
    && adm?.settings?.linkPath === `/book/${publicId}`, JSON.stringify(adm?.settings));
  const profile = (id = publicId, init: Init = {}) => routes.profile.GET(req(`/api/public/booking/${id}`, init), p({ publicId: id }));
  await owner.businessFeatureAccess.updateMany({ where: { businessId: bizA, featureKey: "public_booking" }, data: { state: "DISABLED" } });
  r = await profile();
  const offStatus = r.status;
  const off404 = await body(r);
  const hidden =await body(await routes.settings.GET(own("/api/appointments/booking/settings")));
  r = await routes.link.POST(own("/api/appointments/booking/settings/link", { method: "POST", body: {} }));
  ok("A1 public_booking OFF again → its link answers 404, the owner sees no link, and a new link is refused (409 BOOKING_CLOSED)",
    offStatus === 404 && off404?.error === "NOT_FOUND" && hidden?.settings?.linkPath === null && r.status === 409 && (await body(r))?.error === "BOOKING_CLOSED"
    && (await owner.bookingSettings.findUniqueOrThrow({ where: { businessId: bizA } })).publicId === publicId, JSON.stringify(off404));
  await owner.businessFeatureAccess.updateMany({ where: { businessId: bizA, featureKey: "public_booking" }, data: { state: "ENABLED" } });
  r = await profile();
  const prof = await body(r);
  ok("A2 ON: the business's name and its two open services (not the closed one)", r.status === 200 && prof?.business?.name === `${tag}-A`
    && prof.services.map((x: { id: number }) => x.id).sort().join() === [haircut, color].sort().join(), JSON.stringify(prof));
  ok("A3 …and nothing it did not publish: no address, no phone, no prices, no ids of customers; staff by display name only",
    !("address" in prof.business) && !("phone" in prof.business) && prof.services.every((s: Record<string, unknown>) => !("price" in s))
    && JSON.stringify(prof).indexOf("972") === -1 && prof.services[0].staff?.every((s: Record<string, unknown>) => Object.keys(s).sort().join() === "color,id,name"));
  ok("A3b the closed staff member is not offered", !JSON.stringify(prof).includes("אבי"));
  for (const [name, id] of [["A4 an unknown id", "Zz_unknownPublicId_000000"], ["A5 a malformed id", "short"], ["A6 an SQL-ish id", "' OR 1=1 --zzzzzzzzzzzzz"]] as const) {
    r = await profile(id);
    ok(`${name} → the same 404`, r.status === 404 && JSON.stringify(await body(r)) === JSON.stringify(off404));
  }
  await owner.platformFeaturePolicy.update({ where: { featureKey: "public_booking" }, data: { emergencyDisabled: true } });
  r = await profile();
  ok("A7 the emergency switch closes the link at once (404)", r.status === 404);
  await owner.platformFeaturePolicy.update({ where: { featureKey: "public_booking" }, data: { emergencyDisabled: false } });
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { showPrices: true } }));
  r = await profile();
  ok("A8 prices appear only once the owner shows them", (await body(r))?.services?.every((s: { price?: { amount: number } }) => s.price?.amount === 120));
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { showPrices: false } }));

  // ── B. Free times ──────────────────────────────────────────────────────────────────────────────
  console.log("B. free times");
  const slots = async (q: Record<string, string | number>, id = publicId) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    const res = await routes.slots.GET(req(`/api/public/booking/${id}/slots?${qs}`), p({ publicId: id }));
    return { status: res.status, starts: ((await body(res))?.slots ?? []).map((s: { startsAt: string }) => s.startsAt) as string[] };
  };
  let sl = await slots({ serviceId: haircut, fromDay: SUN, toDay: SUN });
  ok("B1 Sunday, any public staff: 09:00–16:30 every 30 minutes (16)", sl.status === 200 && sl.starts.length === 16 && sl.starts[0] === at("09:00") && sl.starts[15] === at("16:30"), `${sl.starts.length}`);
  ok("B2 the closed Monday: none", (await slots({ serviceId: haircut, fromDay: MON, toDay: MON })).starts.length === 0);
  sl = await slots({ serviceId: haircut, fromDay: TUE, toDay: TUE });
  ok("B3 Tuesday: nothing inside 12:00–14:00", sl.starts.length > 0 && !sl.starts.some((s) => s >= at("12:00", TUE) && s < at("14:00", TUE)));
  sl = await slots({ serviceId: haircut, fromDay: WED, toDay: WED });
  ok("B4 Wednesday: nothing inside the business-wide block 10:00–11:00", sl.starts.length > 0 && !sl.starts.some((s) => s >= at("10:00", WED) && s < at("11:00", WED)));
  ok("B5 a staff member who is not public → 404", (await slots({ serviceId: haircut, staffId: avi.id, fromDay: SUN, toDay: SUN })).status === 404);
  ok("B6 a public staff member who does not perform the service → 404", (await slots({ serviceId: color, staffId: yossi.id, fromDay: SUN, toDay: SUN })).status === 404);
  ok("B7 a service that is not public → 404", (await slots({ serviceId: consult, fromDay: SUN, toDay: SUN })).status === 404);
  const far = addCalendarDays(jerusalemDayKey(new Date()), 70);
  ok("B8 beyond the horizon (60 days): none", (await slots({ serviceId: haircut, fromDay: far, toDay: far })).starts.length === 0);
  const yesterday = addCalendarDays(jerusalemDayKey(new Date()), -1);
  ok("B9 the past: none", (await slots({ serviceId: haircut, fromDay: yesterday, toDay: yesterday })).starts.length === 0);

  // ── C. Submit ──────────────────────────────────────────────────────────────────────────────────
  console.log("C. submit");
  let phoneSeq = 1000000;
  const phone = () => `05${(phoneSeq++).toString().padStart(8, "0")}`;
  const submit = (b: Record<string, unknown>, k: string = key(), init: Init = {}, id = publicId) =>
    routes.submit.POST(req(`/api/public/booking/${id}/requests`, { method: "POST", key: k, body: b, ...init }), p({ publicId: id }));
  const k1 = key();
  const p1 = phone();
  const b1 = { serviceId: haircut, startsAt: at("10:00"), name: "נועה לוי", phone: p1, note: "פעם ראשונה" };
  r = await submit(b1, k1);
  const s1 = await body(r);
  ok("C1 a request: 201, PENDING, its time and a manage token", r.status === 201 && s1?.status === "PENDING" && s1.startsAt === at("10:00") && /^[A-Za-z0-9_-]{43}$/.test(s1.manageToken ?? ""), JSON.stringify(s1));
  const a1 = await one<{ id: number; status: string; holdExpiresAt: Date; createdByActor: string; sourceChannel: string; customerId: number | null; staffMemberId: number }>(
    `SELECT id, status, "holdExpiresAt", "createdByActor", "sourceChannel", "customerId", "staffMemberId" FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("10:00").replace("T", " ").replace("Z", "")}' AND "sourceChannel" = 'PUBLIC_BOOKING'`);
  const rq1 = await one<{ id: number; status: string; contactPhone: string; expiresAt: Date }>(`SELECT id, status, "contactPhone", "expiresAt" FROM "BookingRequest" WHERE "appointmentId" = ${a1.id}`);
  ok("C2 …a PROPOSED appointment by the CUSTOMER through PUBLIC_BOOKING, no customer card linked (D6)", a1.status === "PROPOSED" && a1.createdByActor === "CUSTOMER" && a1.sourceChannel === "PUBLIC_BOOKING" && a1.customerId === null);
  ok("C3 …holding its time 12 hours (D3): the hold and the request's expiry agree", rq1.status === "PENDING" && Math.abs(new Date(rq1.expiresAt).getTime() - Date.now() - 12 * 3600_000) < 120_000
    && new Date(a1.holdExpiresAt).getTime() === new Date(rq1.expiresAt).getTime());
  ok("C4 …the phone stored normalized", rq1.contactPhone === `972${p1.slice(1)}`);
  ok("C5 …journalled as the CUSTOMER (no user), with a BOOKING demand signal", (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${a1.id} AND "eventType" = 'APPOINTMENT_CREATED' AND actor = 'CUSTOMER' AND "actorUserId" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "OfferingDemandSignal" WHERE "appointmentId" = ${a1.id} AND "signalType" = 'BOOKING'`)) === 1);
  ok("C6 …the owner's bell has it at once (in-app only, D3)", (await n(`SELECT count(*)::int AS n FROM "Notification" WHERE "businessId" = ${bizA} AND "dedupeKey" = 'booking-request:${rq1.id}' AND "resolvedAt" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "NotificationDelivery" d JOIN "Notification" x ON x.id = d."notificationId" WHERE x."dedupeKey" = 'booking-request:${rq1.id}' AND d.channel = 'PUSH'`)) === 0);
  ok("C7 …the manage token is stored only as its sha256", (await n(`SELECT count(*)::int AS n FROM "AppointmentManageToken" WHERE "appointmentId" = ${a1.id} AND "tokenHash" = '${sha256Hex(s1.manageToken)}'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentManageToken" WHERE "tokenHash" = '${s1.manageToken}'`)) === 0);
  r = await submit(b1, k1);
  const s1b = await body(r);
  ok("C8 the same request again → 200 replayed, the same booking, a new link", r.status === 200 && s1b?.replayed === true && s1b.startsAt === s1.startsAt && s1b.manageToken !== s1.manageToken
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE "appointmentId" = ${a1.id}`)) === 1);
  const view = (token: string) => routes.manage.POST(req("/api/public/booking/manage", { method: "POST", body: { token, action: "view" } }));
  ok("C9 …and the earlier link stopped working", (await view(s1.manageToken)).status === 404 && (await view(s1b.manageToken)).status === 200);
  r = await submit({ ...b1, startsAt: at("10:30") }, k1);
  ok("C10 the same key with another body → 409 IDEMPOTENCY_KEY_REUSED", r.status === 409 && (await body(r))?.error === "IDEMPOTENCY_KEY_REUSED");
  const refused = async (label: string, b: Record<string, unknown>, status: number, code: string) => {
    const before = await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA}`);
    const res = await submit({ name: "ניסיון עקיפה", phone: phone(), ...b });
    const got = await body(res);
    ok(`${label} → ${status} ${code}, nothing written`, res.status === status && got?.error === code && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA}`)) === before, `${res.status} ${got?.error}`);
  };
  await refused("C11 bypass: the closed Monday", { serviceId: haircut, startsAt: at("10:00", MON) }, 409, "SLOT_UNAVAILABLE");
  await refused("C12 bypass: inside Tuesday's 12:00–14:00 closure", { serviceId: haircut, startsAt: at("12:30", TUE) }, 409, "SLOT_UNAVAILABLE");
  await refused("C13 bypass: inside the business-wide block", { serviceId: haircut, startsAt: at("10:00", WED) }, 409, "SLOT_UNAVAILABLE");
  await refused("C14 bypass: before opening hours", { serviceId: haircut, startsAt: at("08:00") }, 409, "SLOT_UNAVAILABLE");
  await refused("C15 bypass: off the 30-minute step", { serviceId: haircut, startsAt: at("10:10") }, 409, "SLOT_UNAVAILABLE");
  await refused("C16 bypass: beyond the horizon", { serviceId: haircut, startsAt: jerusalemInstantAt(far, 10, 0).toISOString() }, 409, "SLOT_UNAVAILABLE");
  await refused("C17 bypass: in the past", { serviceId: haircut, startsAt: jerusalemInstantAt(yesterday, 10, 0).toISOString() }, 409, "SLOT_UNAVAILABLE");
  await refused("C18 bypass: a service that is not public", { serviceId: consult, startsAt: at("11:00") }, 404, "NOT_FOUND");
  await refused("C19 bypass: a staff member who is not public", { serviceId: haircut, staffId: avi.id, startsAt: at("11:00") }, 404, "NOT_FOUND");
  await refused("C20 bypass: another business's service", { serviceId: svcB, startsAt: at("11:00") }, 404, "NOT_FOUND");
  await refused("C21 the honeypot filled", { serviceId: haircut, startsAt: at("11:00"), website: "http://spam" }, 400, "INVALID_INPUT");
  r = await submit({ serviceId: haircut, startsAt: at("11:00"), name: "רון" });
  ok("C22 no phone (D4) → 400 naming the field", r.status === 400 && (await body(r))?.details?.field === "phone");
  const capPhone = phone();
  const c23 = await submit({ serviceId: haircut, startsAt: at("11:00"), name: "רון א", phone: capPhone });
  const c24 = await submit({ serviceId: haircut, startsAt: at("11:30"), name: "רון א", phone: capPhone });
  const c25 = await submit({ serviceId: haircut, startsAt: at("12:00"), name: "רון א", phone: capPhone });
  ok("C23 the platform cap: two open requests per phone, the third → 429 REQUEST_LIMIT", c23.status === 201 && c24.status === 201 && c25.status === 429 && (await body(c25))?.error === "REQUEST_LIMIT");
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { maxOpenRequestsPerPhone: 1 } }));
  const strict = phone();
  const c26a = await submit({ serviceId: haircut, startsAt: at("12:30"), name: "מאיה", phone: strict });
  const c26b = await submit({ serviceId: haircut, startsAt: at("13:00"), name: "מאיה", phone: strict });
  ok("C24 the business may be stricter (1)", c26a.status === 201 && c26b.status === 429);
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { maxOpenRequestsPerPhone: 2 } }));
  r = await submit({ serviceId: color, startsAt: at("13:00"), name: "שירן", phone: phone() });
  const auto = await body(r);
  const aAuto = await one<{ id: number; status: string; customerId: number | null }>(`SELECT id, status, "customerId" FROM "Appointment" WHERE "businessId" = ${bizA} AND "businessServiceId" = ${color} AND "startsAt" = '${at("13:00").replace("T", " ").replace("Z", "")}'`);
  ok("C25 an automatic service: CONFIRMED at once, the request APPROVED, still no customer card (D6)", r.status === 201 && auto?.status === "CONFIRMED" && aAuto.status === "CONFIRMED" && aAuto.customerId === null
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE "appointmentId" = ${aAuto.id} AND status = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NULL`)) === 1);
  const knownPhone = phone();
  const known = (await owner.customer.create({ data: { businessId: bizA, name: "לקוחה קיימת", phone: `972${knownPhone.slice(1)}` } })).id;
  const kRes = await body(await submit({ serviceId: haircut, startsAt: at("14:00"), name: "מישהי", phone: knownPhone }));
  const uRes = await body(await submit({ serviceId: haircut, startsAt: at("14:30"), name: "מישהי", phone: phone() }));
  ok("C26 a known phone and an unknown one get the same shape of answer — no hint (and no customer name)", JSON.stringify(Object.keys(kRes ?? {}).sort()) === JSON.stringify(Object.keys(uRes ?? {}).sort()) && !JSON.stringify(kRes).includes("לקוחה קיימת"));
  ok("C27 …and nothing is linked automatically", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "customerId" = ${known}`)) === 0);

  // ── D. Concurrency ─────────────────────────────────────────────────────────────────────────────
  console.log("D. concurrency");
  const race = await Promise.all(Array.from({ length: 10 }, () => submit({ serviceId: haircut, staffId: dana.id, startsAt: at("15:00", THU), name: "מתחרה", phone: phone() })));
  ok("D1 ten requests for one staff member's slot at once → exactly one 201, nine 409 SLOT_UNAVAILABLE, no 500", race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409).length === 9, race.map((x) => x.status).join(","));
  ok("D2 …the database holds exactly one", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "staffMemberId" = ${dana.id} AND status IN ('PROPOSED','CONFIRMED') AND "startsAt" = '${at("15:00", THU).replace("T", " ").replace("Z", "")}'`)) === 1);
  const two = await Promise.all([1, 2].map(() => submit({ serviceId: haircut, startsAt: at("16:00", THU), name: "שניים", phone: phone() })));
  const staffAt16 = (await owner.$queryRawUnsafe(`SELECT "staffMemberId" AS s FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("16:00", THU).replace("T", " ").replace("Z", "")}' AND status IN ('PROPOSED','CONFIRMED')`) as { s: number }[]).map((x) => x.s).sort();
  ok("D3 two staff at the same hour: both booked, one each", two.every((x) => x.status === 201) && staffAt16.join() === [dana.id, yossi.id].sort().join(), staffAt16.join());

  // ── E. Assignment ──────────────────────────────────────────────────────────────────────────────
  console.log("E. assignment");
  // Wednesday: Dana carries two, Yossi none → balanced picks Yossi; priority picks Dana (order 0).
  await submit({ serviceId: haircut, staffId: dana.id, startsAt: at("13:00", WED), name: "עומס", phone: phone() });
  await submit({ serviceId: haircut, staffId: dana.id, startsAt: at("13:30", WED), name: "עומס", phone: phone() });
  await submit({ serviceId: haircut, startsAt: at("15:00", WED), name: "מאוזן", phone: phone() });
  const balanced = await one<{ s: number }>(`SELECT "staffMemberId" AS s FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("15:00", WED).replace("T", " ").replace("Z", "")}'`);
  ok("E1 balanced: the free staff member with fewer appointments that day", balanced?.s === yossi.id, String(balanced?.s));
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { assignmentMode: "PRIORITY" } }));
  await submit({ serviceId: haircut, startsAt: at("15:30", WED), name: "עדיפות", phone: phone() });
  const prio = await one<{ s: number }>(`SELECT "staffMemberId" AS s FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '${at("15:30", WED).replace("T", " ").replace("Z", "")}'`);
  ok("E2 priority: the first free staff member in the owner's order, whatever the load", prio?.s === dana.id, String(prio?.s));
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { assignmentMode: "BALANCED", staffChoiceMode: "NONE" } }));
  r = await submit({ serviceId: haircut, staffId: dana.id, startsAt: at("16:00", WED), name: "בחירה", phone: phone() });
  ok("E3 staff choice NONE: naming a staff member → 400", r.status === 400 && (await body(r))?.details?.field === "staffId");
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { staffChoiceMode: "REQUIRED" } }));
  r = await submit({ serviceId: haircut, startsAt: at("16:00", WED), name: "בחירה", phone: phone() });
  ok("E4 staff choice REQUIRED: none named → 400", r.status === 400 && (await body(r))?.details?.field === "staffId");
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { staffChoiceMode: "OPTIONAL" } }));
  const yossiBefore = await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "staffMemberId" = ${yossi.id} AND status IN ('PROPOSED','CONFIRMED')`);
  await staffPatch(yossi, { publicBookable: false });
  ok("E5 taking a staff member off the link changes none of their appointments", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "staffMemberId" = ${yossi.id} AND status IN ('PROPOSED','CONFIRMED')`)) === yossiBefore && yossiBefore > 0);
  ok("E6 …and they are no longer offered", (await slots({ serviceId: haircut, staffId: yossi.id, fromDay: SUN, toDay: SUN })).status === 404);
  await staffPatch(yossi, { publicBookable: true });

  // ── F. The owner decides ───────────────────────────────────────────────────────────────────────
  console.log("F. decisions");
  r = await routes.requests.GET(own("/api/appointments/booking/requests"));
  const list = await body(r);
  const row1 = list?.pending?.find((x: { id: number }) => x.id === rq1.id);
  ok("F1 the owner's list: the pending request with its phone and note, no match for a new phone", r.status === 200 && row1?.contactPhone === rq1.contactPhone && row1.note === "פעם ראשונה" && row1.match === null);
  ok("F2 …a known phone shows its match — to the owner only", list.pending.some((x: { match: { customerId: number } | null }) => x.match?.customerId === known));
  const decide = (id: number, action: string, version: number, init: Init = {}) =>
    routes.request.POST(own(`/api/appointments/booking/requests/${id}`, { method: "POST", key: key(), body: { action, expectedVersion: version }, ...init }), p({ id: String(id) }));
  const ver = async (apptId: number) => (await owner.appointment.findUniqueOrThrow({ where: { id: apptId } })).version;
  r = await decide(rq1.id, "approve", await ver(a1.id));
  ok("F3 approve → the appointment CONFIRMED, the request APPROVED by the owner, the bell resolved", r.status === 200
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${a1.id} AND status = 'CONFIRMED' AND "holdExpiresAt" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${rq1.id} AND status = 'APPROVED' AND "decidedByUserId" = ${userA}`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "Notification" WHERE "dedupeKey" = 'booking-request:${rq1.id}' AND "resolvedAt" IS NOT NULL`)) === 1, String(r.status));
  r = await decide(rq1.id, "approve", await ver(a1.id));
  ok("F4 approving it again → 409", r.status === 409);
  const reqOf = async (startsAt: string) => one<{ rid: number; aid: number }>(`SELECT r.id AS rid, a.id AS aid FROM "BookingRequest" r JOIN "Appointment" a ON a.id = r."appointmentId" WHERE a."businessId" = ${bizA} AND a."startsAt" = '${startsAt.replace("T", " ").replace("Z", "")}' AND r.status = 'PENDING' ORDER BY r.id DESC LIMIT 1`);
  const d1 = await reqOf(at("11:00"));
  r = await decide(d1.rid, "decline", await ver(d1.aid));
  ok("F5 decline → the appointment CANCELED (DECLINED), the request DECLINED", r.status === 200
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${d1.aid} AND status = 'CANCELED' AND "cancelReason" = 'DECLINED'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${d1.rid} AND status = 'DECLINED'`)) === 1);
  r = await submit({ serviceId: haircut, staffId: (await owner.appointment.findUniqueOrThrow({ where: { id: d1.aid } })).staffMemberId, startsAt: at("11:00"), name: "אחרי דחייה", phone: phone() });
  ok("F6 …the time is free again", r.status === 201, String(r.status));
  const d2 = await reqOf(at("11:30"));
  r = await routes.status.POST(own(`/api/appointments/${d2.aid}/status`, { method: "POST", key: key(), body: { to: "CANCELED", cancelReason: "OWNER_CANCELED", expectedVersion: await ver(d2.aid) } }), p({ id: String(d2.aid) }));
  ok("F7 cancelling a pending public appointment from the calendar settles its request (DECLINED)", r.status === 200 && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${d2.rid} AND status = 'DECLINED'`)) === 1);
  // The owner's own appointment stays in the business's lane, which closes every staff lane at its time (P0-1): it sits
  // at 08:00, before opening, so it takes no time the link offers (J books 09:00 on this Thursday).
  const ownAppt = await body(await routes.root.POST(own("/api/appointments", { method: "POST", key: key(), body: { startsAt: at("08:00", THU), durationMinutes: 30, status: "PROPOSED" } })));
  r = await routes.status.POST(own(`/api/appointments/${ownAppt.appointment.id}/status`, { method: "POST", key: key(), body: { to: "CANCELED", cancelReason: "DECLINED" } }), p({ id: String(ownAppt.appointment.id) }));
  ok("F8 DECLINED is refused for an appointment that is not a public request (400)", r.status === 400);
  const near = await reqOf(at("14:00"));
  await owner.bookingRequest.update({ where: { id: near.rid }, data: { expiresAt: new Date(Date.now() + 4000) } });
  r = await decide(near.rid, "approve", await ver(near.aid));
  ok("F9 approve a few seconds before the expiry → 200", r.status === 200);
  const late = await reqOf(at("14:30"));
  await owner.bookingRequest.update({ where: { id: late.rid }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await decide(late.rid, "approve", await ver(late.aid));
  ok("F10 approve after the expiry → 409 REQUEST_EXPIRED, nothing approved", r.status === 409 && (await body(r))?.error === "REQUEST_EXPIRED"
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${late.aid} AND status = 'PROPOSED'`)) === 1);

  // ── G. Expiry ──────────────────────────────────────────────────────────────────────────────────
  console.log("G. expiry");
  let rep = await runBookingSweep(new Date());
  ok("G1 the sweeper expires the lapsed request: the appointment CANCELED (EXPIRED) by the SYSTEM, the request EXPIRED", rep.expired >= 1
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${late.aid} AND status = 'CANCELED' AND "cancelReason" = 'EXPIRED'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${late.aid} AND "eventType" = 'APPOINTMENT_CANCELED' AND actor = 'SYSTEM'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${late.rid} AND status = 'EXPIRED'`)) === 1, JSON.stringify(rep));
  const lateStaff = (await owner.appointment.findUniqueOrThrow({ where: { id: late.aid } })).staffMemberId;
  r = await submit({ serviceId: haircut, staffId: lateStaff, startsAt: at("14:30"), name: "אחרי תפוגה", phone: phone() });
  ok("G2 …its time is free again", r.status === 201, String(r.status));
  const lazy = await reqOf(at("12:30"));
  await owner.bookingRequest.update({ where: { id: lazy.rid }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const lazyStaff = (await owner.appointment.findUniqueOrThrow({ where: { id: lazy.aid } })).staffMemberId;
  r = await submit({ serviceId: haircut, staffId: lazyStaff, startsAt: at("12:30"), name: "לפני הסורק", phone: phone() });
  ok("G3 a lapsed request releases its time even before the sweeper runs", r.status === 201 && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${lazy.rid} AND status = 'EXPIRED'`)) === 1, String(r.status));

  // ── H. Reminders ───────────────────────────────────────────────────────────────────────────────
  console.log("H. reminders");
  const rem = await reqOf(at("11:00"));
  await owner.pushSubscription.create({ data: { businessId: bizA, userId: userA, endpoint: "https://push.example.invalid/sub-1", p256dh: "x", auth: "y", platform: "other" } });
  // The daytime checks sweep at a daytime moment (the latest one not after now), whatever hour CI runs at.
  let dayNow = new Date();
  while (isQuietHours(dayNow, "Asia/Jerusalem")) dayNow = new Date(dayNow.getTime() - 30 * 60_000);
  const shiftBack = async (hours: number) => {
    const created = new Date(dayNow.getTime() - hours * 3600_000 - 60_000);
    await owner.bookingRequest.update({ where: { id: rem.rid }, data: { createdAt: created } });
    // As the timeline would have it: the last notice went out at the previous reminder's moment (or at creation).
    await owner.notification.updateMany({ where: { businessId: bizA, dedupeKey: `booking-request:${rem.rid}` }, data: { lastNotifiedAt: new Date(created.getTime() + (hours - 2) * 3600_000) } });
  };
  const delivered = (ch: string) => n(`SELECT count(*)::int AS n FROM "NotificationDelivery" d JOIN "Notification" x ON x.id = d."notificationId" WHERE x."dedupeKey" = 'booking-request:${rem.rid}' AND d.channel = '${ch}'`);
  const inApp0 = await delivered("IN_APP");
  await shiftBack(2);
  rep = await runBookingSweep(dayNow);
  ok("H1 two hours waiting: a reminder — the bell again (unread) and a push attempt", rep.reminded >= 1 && (await delivered("IN_APP")) === inApp0 + 1 && (await delivered("PUSH")) >= 1
    && (await n(`SELECT count(*)::int AS n FROM "Notification" WHERE "dedupeKey" = 'booking-request:${rem.rid}' AND "readAt" IS NULL`)) === 1, JSON.stringify(rep));
  const inApp1 = await delivered("IN_APP");
  await runBookingSweep(dayNow);
  await runBookingSweep(new Date(dayNow.getTime() + 10 * 60_000));
  ok("H2 sweeping again within the window sends nothing more", (await delivered("IN_APP")) === inApp1);
  await shiftBack(4);
  await runBookingSweep(dayNow);
  ok("H3 four hours: the second reminder", (await delivered("IN_APP")) === inApp1 + 1);
  r = await decide(rem.rid, "approve", await ver(rem.aid));
  await shiftBack(6);
  const inApp2 = await delivered("IN_APP");
  await runBookingSweep(dayNow);
  ok("H4 decided: no reminder ever again", r.status === 200 && (await delivered("IN_APP")) === inApp2);

  // Quiet hours, replayed on a past night (Jerusalem, 22:00–08:00): created 21:00, lapses 09:00 the next morning.
  r = await submit({ serviceId: haircut, startsAt: at("15:30"), name: "לילה", phone: phone() });
  const night = await reqOf(at("15:30"));
  const nightDay = addCalendarDays(jerusalemDayKey(new Date()), -3);
  const nightAt = (hh: number, mm = 0, nextDay = false) => jerusalemInstantAt(nextDay ? addCalendarDays(nightDay, 1) : nightDay, hh, mm);
  await owner.bookingRequest.update({ where: { id: night.rid }, data: { createdAt: nightAt(21), expiresAt: nightAt(9, 0, true) } });
  await owner.notification.updateMany({ where: { businessId: bizA, dedupeKey: `booking-request:${night.rid}` }, data: { lastNotifiedAt: nightAt(21) } });
  const nightCount = (ch: string) => n(`SELECT count(*)::int AS n FROM "NotificationDelivery" d JOIN "Notification" x ON x.id = d."notificationId" WHERE x."dedupeKey" = 'booking-request:${night.rid}' AND d.channel = '${ch}'`);
  const nIn0 = await nightCount("IN_APP"), nPush0 = await nightCount("PUSH");
  await runBookingSweep(nightAt(23, 5));
  await runBookingSweep(nightAt(3, 0, true));
  await runBookingSweep(nightAt(7, 55, true));
  ok("H7 quiet hours: nothing at 23:05, 03:00 or 07:55 though a reminder was due at 23:00", r.status === 201 && (await nightCount("IN_APP")) === nIn0 && (await nightCount("PUSH")) === nPush0);
  rep = await runBookingSweep(nightAt(8, 0, true));
  ok("H8 08:00: exactly one reminder for the request still waiting — bell and push", (await nightCount("IN_APP")) === nIn0 + 1 && (await nightCount("PUSH")) === nPush0 + 1, JSON.stringify(rep));
  await runBookingSweep(nightAt(8, 0, true));
  await runBookingSweep(nightAt(8, 10, true));
  await runBookingSweep(nightAt(8, 50, true));
  ok("H9 no duplicate: 08:00 again, 08:10 and 08:50 send nothing", (await nightCount("IN_APP")) === nIn0 + 1 && (await nightCount("PUSH")) === nPush0 + 1);
  rep = await runBookingSweep(nightAt(10, 0, true));
  ok("H10 at 09:00 it lapsed (expiry unchanged): expired, never reminded at 10:00", (await nightCount("IN_APP")) === nIn0 + 1
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${night.rid} AND status = 'EXPIRED'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "Notification" WHERE "dedupeKey" = 'booking-request:${night.rid}' AND "resolvedAt" IS NOT NULL`)) === 1, JSON.stringify(rep));
  await runBookingSweep(nightAt(12, 0, true));
  ok("H11 …and nothing after", (await nightCount("IN_APP")) === nIn0 + 1 && (await nightCount("PUSH")) === nPush0 + 1);
  r = await routes.sweep.GET(req("/api/appointments/booking/sweep"));
  ok("H5 the sweep route without the cron secret → 401", r.status === 401);
  r = await routes.sweep.GET(req("/api/appointments/booking/sweep", { bearer: process.env.CRON_SECRET }));
  ok("H6 …with it → 200", r.status === 200, String(r.status));

  // ── I. Linking the customer (D6) ───────────────────────────────────────────────────────────────
  console.log("I. linking the customer");
  r = await routes.requests.GET(own("/api/appointments/booking/requests"));
  const toLink = (await body(r))?.toLink ?? [];
  const autoRow = toLink.find((x: { appointment: { id: number } }) => x.appointment.id === aAuto.id);
  ok("I1 a confirmed request without a card waits to be linked", !!autoRow && autoRow.match === null);
  const link = (id: number, b: Record<string, unknown>, version: number, init: Init = {}) =>
    routes.request.POST(own(`/api/appointments/booking/requests/${id}`, { method: "POST", body: { action: "link", ...b, expectedVersion: version }, ...init }), p({ id: String(id) }));
  r = await link(autoRow.id, { create: true }, await ver(aAuto.id));
  const created = await body(r);
  ok("I2 a new card from the request's name and phone, linked", r.status === 200 && (await n(`SELECT count(*)::int AS n FROM "Customer" WHERE id = ${created?.customerId} AND name = 'שירן'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${aAuto.id} AND "customerId" = ${created?.customerId}`)) === 1);
  r = await link(autoRow.id, { create: true }, await ver(aAuto.id));
  ok("I3 linking again → 409", r.status === 409);
  const kn = await one<{ rid: number; aid: number }>(`SELECT r.id AS rid, a.id AS aid FROM "BookingRequest" r JOIN "Appointment" a ON a.id = r."appointmentId" WHERE a."businessId" = ${bizA} AND r."contactPhone" = '972${knownPhone.slice(1)}'`);
  r = await link(kn.rid, { create: true }, await ver(kn.aid));
  ok("I4 never a second card for a known phone → 409 PHONE_EXISTS naming the match", r.status === 409 && (await body(r))?.details?.customerId === known);
  r = await link(kn.rid, { customerId: known }, await ver(kn.aid));
  ok("I5 linked to the match by the owner's choice", r.status === 200 && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${kn.aid} AND "customerId" = ${known}`)) === 1);

  // ── J. The customer's link ─────────────────────────────────────────────────────────────────────
  console.log("J. the customer's link");
  const mine = await body(await submit({ serviceId: haircut, startsAt: at("09:00", THU), name: "ליאור", phone: phone() }));
  const manage = (token: string, action: string, init: Init = {}) => routes.manage.POST(req("/api/public/booking/manage", { method: "POST", body: { token, action }, ...init }));
  r = await manage(mine.manageToken, "view");
  const v1 = await body(r);
  ok("J1 view: PENDING, may withdraw, and no staff contact or customer data", r.status === 200 && v1?.state === "PENDING" && v1.canCancel === true && !JSON.stringify(v1).includes("972"));
  r = await manage(mine.manageToken, "cancel");
  const mr = await one<{ id: number; status: string; appointmentId: number }>(`SELECT r.id, r.status, r."appointmentId" FROM "BookingRequest" r JOIN "AppointmentManageToken" t ON t."appointmentId" = r."appointmentId" WHERE t."tokenHash" = '${sha256Hex(mine.manageToken)}'`);
  ok("J2 withdraw: the request WITHDRAWN, the appointment CANCELED by the CUSTOMER, the owner told", r.status === 200 && (await body(r))?.state === "CANCELED" && mr.status === "WITHDRAWN"
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${mr.appointmentId} AND "eventType" = 'APPOINTMENT_CANCELED' AND actor = 'CUSTOMER'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "Notification" WHERE "dedupeKey" = 'booking-request:${mr.id}' AND title LIKE '%ביטל%'`)) === 1);
  r = await manage(mine.manageToken, "cancel");
  ok("J3 cancelling again answers as is (idempotent)", r.status === 200 && (await body(r))?.state === "CANCELED");
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { selfCancelWindowHours: 720 } }));
  r = await manage(s1b.manageToken, "cancel");
  ok("J4 a confirmed appointment inside the business's window → 409 SELF_CANCEL_CLOSED", r.status === 409 && (await body(r))?.error === "SELF_CANCEL_CLOSED");
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { selfCancelWindowHours: 24, selfCancelEnabled: false } }));
  r = await manage(s1b.manageToken, "view");
  ok("J5 self-cancel switched off: the link says so", r.status === 200 && (await body(r))?.canCancel === false);
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { selfCancelEnabled: true } }));
  r = await manage(s1b.manageToken, "view");
  ok("J6 on again, outside the 24-hour window: the customer may cancel", (await body(r))?.canCancel === true);
  ok("J7 a garbage or truncated token → 404", (await manage("x".repeat(43), "view")).status === 404 && (await manage(s1b.manageToken.slice(0, 20), "view")).status === 404);

  // ── K. Isolation ───────────────────────────────────────────────────────────────────────────────
  console.log("K. isolation");
  r = await routes.requests.GET(own("/api/appointments/booking/requests", { token: tokenB }));
  const lb = await body(r);
  ok("K1 business B's owner sees none of A's requests", r.status === 200 && lb.pending.length === 0 && lb.toLink.length === 0 && lb.recent.length === 0);
  const anyA = await reqOf(at("16:00", THU)) ?? await reqOf(at("15:00", THU));
  r = await decide(anyA.rid, "approve", await ver(anyA.aid), { token: tokenB });
  ok("K2 …cannot decide one (404), and nothing changed", r.status === 404 && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${anyA.rid} AND status = 'PENDING'`)) === 1);
  r = await link(anyA.rid, { create: true }, await ver(anyA.aid), { token: tokenB });
  ok("K3 …nor link a card to it (404)", r.status === 404);
  r = await routes.settings.GET(own("/api/appointments/booking/settings", { token: tokenB }));
  ok("K4 B's settings are B's own (no link of A's)", r.status === 200 && (await body(r))?.settings?.publicId !== publicId);

  // ── L. Settings ────────────────────────────────────────────────────────────────────────────────
  console.log("L. settings");
  r = await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { maxOpenRequestsPerPhone: 3 } }));
  ok("L1 the owner cannot raise the per-phone cap above the platform's (400)", r.status === 400);
  const st = await body(await routes.settings.GET(own("/api/appointments/booking/settings")));
  r = await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { showAddress: true, expectedVersion: st.settings.version - 1 } }));
  ok("L2 a stale screen → 409 VERSION_CONFLICT", r.status === 409);
  r = await routes.link.POST(own("/api/appointments/booking/settings/link", { method: "POST", body: {} }));
  const newId = (await body(r))?.settings?.publicId;
  ok("L3 a new link: the old one stops at once, the new one works", r.status === 200 && newId !== publicId && (await profile(publicId)).status === 404 && (await profile(newId)).status === 200);
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { enabled: false } }));
  r = await submit({ serviceId: haircut, startsAt: at("16:30"), name: "אחרי עצירה", phone: phone() }, key(), {}, newId);
  ok("L4 the business's switch off: requests stop immediately (404)", r.status === 404 && (await profile(newId)).status === 404);
  await routes.settings.PUT(own("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true } }));

  // ── M. Abuse ───────────────────────────────────────────────────────────────────────────────────
  console.log("M. abuse");
  const ip = "10.99.99.99";
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(await submit({ serviceId: haircut, startsAt: at("16:30"), name: "x", phone: "1" }, key(), { ip }, newId));
  ok("M1 six submissions in a minute from one IP: the sixth → 429", burst[5].status === 429, burst.map((x) => x.status).join(","));
  const beforeAll = await n(`SELECT count(*)::int AS n FROM "Appointment"`);
  process.env.RATE_LIMIT_BACKEND = "redis";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9";
  process.env.UPSTASH_REDIS_REST_TOKEN = "lab";
  const down1 = await profile(newId);
  const down2 = await submit({ serviceId: haircut, startsAt: at("16:30"), name: "בזמן תקלה", phone: phone() }, key(), {}, newId);
  process.env.RATE_LIMIT_BACKEND = "memory";
  ok("M2 the limiter is down: the link answers 503 and writes nothing (fail closed)", down1.status === 503 && down2.status === 503 && (await n(`SELECT count(*)::int AS n FROM "Appointment"`)) === beforeAll, `${down1.status} ${down2.status}`);
  r = await submit({ serviceId: haircut, startsAt: at("16:30"), name: "x", phone: phone() }, key(), { contentType: "text/plain" }, newId);
  ok("M3 a non-JSON post (a cross-site form) → 415", r.status === 415);

  // ── N. Regression ──────────────────────────────────────────────────────────────────────────────
  console.log("N. regression");
  r = await routes.root.GET(own(`/api/appointments?from=${at("00:00")}&to=${at("23:59")}`));
  const day = (await body(r))?.appointments as Array<{ id: number; booking: { contactName: string } | null }>;
  ok("N1 the calendar lists public appointments with who asked (the owner's eyes)", r.status === 200 && day.find((x) => x.id === a1.id)?.booking?.contactName === "נועה לוי");
  r = await routes.root.POST(own("/api/appointments", { method: "POST", key: key(), body: { startsAt: at("10:00", MON), durationMinutes: 30 } }));
  ok("N2 the owner may still book the closed Monday, with the warning (the owner's exception is untouched)", r.status === 201 && JSON.stringify((await body(r))?.warnings) === JSON.stringify(["OUTSIDE_AVAILABILITY"]));

  // ── O. The link offers only the business's own hours (owner decision 2026-10-28) ───────────────────
  // The business is open Sun–Thu 09:00–17:00 (closed on this Monday, 12:00–14:00 closed on Tuesday). "רון" works his
  // own hours, 08:00–19:00 every weekday: on the owner's calendar they stand; on the link they may only narrow.
  console.log("O. the business's hours bound the link");
  const ron = await mkStaff("רון");
  await routes.staffServices.PUT(own(`/api/appointments/staff/${ron.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }, { businessServiceId: color }] } }), p({ staffId: String(ron.id) }));
  await staffPatch(ron, { publicBookable: true, sortOrder: 9 });
  r = await routes.availability.PUT(own("/api/appointments/availability", { method: "PUT", body: { staffMemberId: ron.id, rules: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 19 * 60 })) } }));
  const lateHours = r.status === 200;
  const outside = (starts: string[], day: string) => starts.filter((s) => s < at("09:00", day) || s >= at("17:00", day));
  let o = await slots({ serviceId: haircut, staffId: ron.id, fromDay: SUN, toDay: SUN }, newId);
  ok("O1 own hours 08:00–19:00 → on the link only 09:00–16:30 (a 30-minute service ends by 17:00)", lateHours && o.status === 200
    && o.starts[0] === at("09:00") && o.starts.at(-1) === at("16:30") && outside(o.starts, SUN).length === 0, JSON.stringify([o.starts[0], o.starts.at(-1)]));
  o = await slots({ serviceId: color, staffId: ron.id, fromDay: SUN, toDay: SUN }, newId);
  ok("O2 the service's length counts: a 60-minute service starts by 16:00 at the latest", o.starts.at(-1) === at("16:00") && outside(o.starts, SUN).length === 0, String(o.starts.at(-1)));
  o = await slots({ serviceId: haircut, fromDay: SUN, toDay: SUN }, newId);
  ok("O3 \"any staff\" is bounded the same way (none before 09:00 or from 17:00)", o.starts.length > 0 && outside(o.starts, SUN).length === 0, JSON.stringify(outside(o.starts, SUN)));
  o = await slots({ serviceId: haircut, staffId: ron.id, fromDay: TUE, toDay: TUE }, newId);
  ok("O4 the business's own closure (Tuesday 12:00–14:00) holds for a staff member with own hours", o.starts.length > 0
    && !o.starts.some((s) => s >= at("11:31", TUE) && s < at("14:00", TUE)) && outside(o.starts, TUE).length === 0);
  ok("O5 a day the business is closed (this Monday): nothing, whatever the staff member's own hours", (await slots({ serviceId: haircut, staffId: ron.id, fromDay: MON, toDay: MON }, newId)).starts.length === 0);
  o = await slots({ serviceId: haircut, staffId: dana.id, fromDay: SUN, toDay: SUN }, newId);
  ok("O6 a staff member without own hours still follows the business hours", o.starts.length > 0 && outside(o.starts, SUN).length === 0);
  const beforeO = await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA}`);
  r = await submit({ serviceId: haircut, staffId: ron.id, startsAt: at("17:00"), name: "אחרי הסגירה", phone: phone() }, key(), {}, newId);
  const after = r.status;
  r = await submit({ serviceId: haircut, staffId: ron.id, startsAt: at("08:30"), name: "לפני הפתיחה", phone: phone() }, key(), {}, newId);
  ok("O7 the server refuses a request outside the business hours even for that staff member (409 SLOT_UNAVAILABLE), nothing written", after === 409 && r.status === 409
    && (await body(r))?.error === "SLOT_UNAVAILABLE" && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA}`)) === beforeO, `${after} ${r.status}`);
  r = await submit({ serviceId: haircut, startsAt: at("17:00"), name: "כל איש צוות", phone: phone() }, key(), {}, newId);
  ok("O8 automatic staff choice never lands outside the business hours (17:00 → 409)", r.status === 409, String(r.status));
  r = await submit({ serviceId: haircut, staffId: ron.id, startsAt: at("16:30"), name: "בתוך השעות", phone: phone() }, key(), {}, newId);
  ok("O9 inside the business hours that staff member is booked as usual", r.status === 201, String(r.status));
  r = await routes.root.POST(own("/api/appointments", { method: "POST", key: key(), body: { startsAt: at("18:00"), durationMinutes: 30, staffMemberId: ron.id } }));
  ok("O10 the owner's own calendar is unchanged: 18:00 with that staff member is inside his hours (201, no warning)", r.status === 201
    && JSON.stringify((await body(r))?.warnings ?? []) === "[]", JSON.stringify(await body(r)));

  // ── P. P0-1 (owner, 2026-11-01): the business's lane and the staff lanes exclude each other on the link too;
  //    a phone's self-booked AUTO appointments count toward its cap ─────────────────────────────────────────
  // A business of its own (C): its link, its staff, its per-business submit ceiling untouched by the sections above.
  console.log("P. P0-1: lanes on the link, AUTO bookings and the per-phone cap");
  const bizC = (await owner.business.create({ data: { name: `${tag}-C` } })).id;
  const userC = (await owner.user.create({ data: { email: `${tag}-c@lab.test`, password: "x", businessId: bizC } })).id;
  const tokenC = signAuthToken(userC, 0);
  const ownC = (path: string, init: Init = {}) => req(path, { ...init, token: tokenC });
  await owner.businessFeatureAccess.create({ data: { businessId: bizC, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  await owner.businessFeatureAccess.create({ data: { businessId: bizC, featureKey: "public_booking", state: "ENABLED", reason: "lab" } });
  const cutC = await svc(bizC, "תספורת", 30);
  const autoC = await svc(bizC, "צבע", 60);
  const shir = (await body(await routes.staff.POST(ownC("/api/appointments/staff", { method: "POST", body: { displayName: "שיר" } }))))?.staffMember;
  const tal = (await body(await routes.staff.POST(ownC("/api/appointments/staff", { method: "POST", body: { displayName: "טל" } }))))?.staffMember;
  for (const s of [shir, tal]) {
    await routes.staffServices.PUT(ownC(`/api/appointments/staff/${s.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: cutC }, { businessServiceId: autoC }] } }), p({ staffId: String(s.id) }));
    const v = (await owner.staffMember.findUniqueOrThrow({ where: { id: s.id } })).version;
    await routes.staffOne.PATCH(ownC(`/api/appointments/staff/${s.id}`, { method: "PATCH", body: { publicBookable: true, expectedVersion: v } }), p({ staffId: String(s.id) }));
  }
  await routes.availability.PUT(ownC("/api/appointments/availability", { method: "PUT", body: { rules: weekly } }));
  await routes.policy.PUT(ownC(`/api/appointments/services/${cutC}/policy`, { method: "PUT", body: { publicBookable: true, approvalMode: "MANUAL", slotStepMinutes: 30, maxAdvanceDays: 60 } }), p({ serviceId: String(cutC) }));
  await routes.policy.PUT(ownC(`/api/appointments/services/${autoC}/policy`, { method: "PUT", body: { publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 30, maxAdvanceDays: 60 } }), p({ serviceId: String(autoC) }));
  r = await routes.settings.PUT(ownC("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL" } }));
  const pubC: string = (await body(r))?.settings?.publicId;
  ok("P0 business C: its own link, two public staff, a MANUAL and an AUTO service, the cap at its default 2", r.status === 200 && /^[A-Za-z0-9_-]{24}$/.test(pubC ?? "")
    && (await owner.bookingSettings.findUniqueOrThrow({ where: { businessId: bizC } })).maxOpenRequestsPerPhone === 2);
  // The next week (Sunday to Thursday), open 09:00–17:00, nothing booked.
  const W = (d: number) => addCalendarDays(SUN, 7 + d);
  const tsC = (iso: string) => iso.replace("T", " ").replace("Z", "");
  const subC = (b: Record<string, unknown>, k: string = key()) => submit(b, k, {}, pubC);
  const ownCreateC = (b: Record<string, unknown>) => routes.root.POST(ownC("/api/appointments", { method: "POST", key: key(), body: b }));
  const apptsC = () => n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizC}`);
  const activeInC = (from: string, to: string) => n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizC} AND status IN ('PROPOSED','CONFIRMED') AND "endsAt" IS NOT NULL AND "startsAt" < '${tsC(to)}' AND "endsAt" > '${tsC(from)}'`);
  const reqAt = (iso: string) => one<{ aid: number; rid: number }>(`SELECT a.id AS aid, r.id AS rid FROM "Appointment" a JOIN "BookingRequest" r ON r."appointmentId" = a.id WHERE a."businessId" = ${bizC} AND a."startsAt" = '${tsC(iso)}' ORDER BY r.id DESC LIMIT 1`);

  // Lanes, on the link.
  r = await ownCreateC({ kind: "CUSTOMER", startsAt: at("10:00", W(0)), durationMinutes: 60 });
  const generalC = (await body(r))?.appointment;
  ok("P1 the owner books a general appointment (no staff member) 10:00–11:00", r.status === 201 && generalC?.staffMemberId === null, String(r.status));
  let pc = await slots({ serviceId: cutC, fromDay: W(0), toDay: W(0) }, pubC);
  ok("P2 the link (any staff) offers nothing that overlaps it, and the times around it", pc.status === 200 && pc.starts.includes(at("09:30", W(0))) && pc.starts.includes(at("11:00", W(0)))
    && !pc.starts.includes(at("10:00", W(0))) && !pc.starts.includes(at("10:30", W(0))), JSON.stringify(pc.starts.slice(0, 6)));
  pc = await slots({ serviceId: cutC, staffId: shir.id, fromDay: W(0), toDay: W(0) }, pubC);
  ok("P3 …nor for a chosen staff member", pc.status === 200 && pc.starts.length > 0 && !pc.starts.includes(at("10:00", W(0))) && !pc.starts.includes(at("10:30", W(0))));
  let cBefore = await apptsC();
  const p4a = await subC({ serviceId: cutC, startsAt: at("10:00", W(0)), name: "עקיפה", phone: phone() });
  const p4b = await subC({ serviceId: cutC, staffId: tal.id, startsAt: at("10:30", W(0)), name: "עקיפה", phone: phone() });
  ok("P4 a request straight through the API over it (any staff / a chosen one) → 409 SLOT_UNAVAILABLE, nothing written",
    p4a.status === 409 && (await body(p4a))?.error === "SLOT_UNAVAILABLE" && p4b.status === 409 && (await apptsC()) === cBefore, `${p4a.status} ${p4b.status}`);
  r = await subC({ serviceId: cutC, staffId: shir.id, startsAt: at("12:00", W(0)), name: "נועה", phone: phone() });
  const pShir = await reqAt(at("12:00", W(0)));
  ok("P5 a public request for Shir at 12:00 → 201 PENDING (holding its time)", r.status === 201 && (await body(r))?.status === "PENDING" && !!pShir);
  r = await ownCreateC({ kind: "INTERNAL", title: "ישיבה", startsAt: at("12:00", W(0)), durationMinutes: 30 });
  ok("P6 the owner's general meeting over that waiting request → 409 SLOT_CONFLICT naming it", r.status === 409 && JSON.stringify((await body(r))?.details?.conflictingAppointmentIds) === JSON.stringify([pShir.aid]));
  cBefore = await apptsC();
  r = await ownCreateC({ kind: "BLOCK", title: "סגור", startsAt: at("11:30", W(0)), durationMinutes: 90 });
  ok("P7 owner decision A: a business-wide block over the waiting request → 409, no block written, the request still PENDING", r.status === 409 && (await apptsC()) === cBefore
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE id = ${pShir.rid} AND status = 'PENDING'`)) === 1, String(r.status));
  r = await subC({ serviceId: cutC, staffId: tal.id, startsAt: at("12:00", W(0)), name: "מקביל", phone: phone() });
  ok("P8 Tal at the same hour as Shir → 201 (staff lanes stay parallel)", r.status === 201, String(r.status));

  // Concurrency across lanes: public requests for a staff member and the owner's general appointments, one slot.
  const mixed = await Promise.all([
    ...Array.from({ length: 6 }, () => subC({ serviceId: cutC, staffId: shir.id, startsAt: at("14:00", W(1)), name: "מרוץ", phone: phone() })),
    ...Array.from({ length: 6 }, () => ownCreateC({ kind: "INTERNAL", title: "מרוץ", startsAt: at("14:00", W(1)), durationMinutes: 30 })),
  ]);
  ok("P9 twelve at once (six public for Shir, six general by the owner) → exactly one 201, eleven 409, no 500", mixed.filter((x) => x.status === 201).length === 1
    && mixed.filter((x) => x.status === 409).length === 11 && (await activeInC(at("14:00", W(1)), at("14:30", W(1)))) === 1, mixed.map((x) => x.status).join(","));
  const blockRace = await Promise.all([
    ...Array.from({ length: 4 }, () => ownCreateC({ kind: "BLOCK", title: "סגור", startsAt: at("15:00", W(1)), durationMinutes: 30 })),
    ...Array.from({ length: 4 }, () => subC({ serviceId: cutC, staffId: tal.id, startsAt: at("15:00", W(1)), name: "מרוץ", phone: phone() })),
  ]);
  ok("P10 a block racing public requests for one time → exactly one of the eight, seven 409", blockRace.filter((x) => x.status === 201).length === 1
    && blockRace.filter((x) => x.status === 409).length === 7 && (await activeInC(at("15:00", W(1)), at("15:30", W(1)))) === 1, blockRace.map((x) => x.status).join(","));

  // Approving re-checks the time under the lock: an overlap across lanes written before this rule is refused.
  r = await subC({ serviceId: cutC, staffId: shir.id, startsAt: at("10:00", W(2)), name: "ממתינה", phone: phone() });
  const pw = await reqAt(at("10:00", W(2)));
  const oldGeneral = (await owner.appointment.create({ data: { businessId: bizC, kind: "INTERNAL", status: "CONFIRMED", title: "ישן", startsAt: new Date(at("10:00", W(2))), endsAt: new Date(at("10:30", W(2))), durationMinutes: 30, createdByActor: "OWNER", createdByUserId: userC, sourceChannel: "INBOX_WEB" } })).id;
  const decideC = async (rid: number, action: string, aid: number) => routes.request.POST(ownC(`/api/appointments/booking/requests/${rid}`, { method: "POST", key: key(), body: { action, expectedVersion: (await owner.appointment.findUniqueOrThrow({ where: { id: aid } })).version } }), p({ id: String(rid) }));
  r = await decideC(pw.rid, "approve", pw.aid);
  ok("P11 approving a request that overlaps another lane → 409 SLOT_CONFLICT; the request still PENDING, the appointment PROPOSED", r.status === 409 && (await body(r))?.error === "SLOT_CONFLICT"
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" r JOIN "Appointment" a ON a.id = r."appointmentId" WHERE r.id = ${pw.rid} AND r.status = 'PENDING' AND a.status = 'PROPOSED'`)) === 1, String(r.status));
  await owner.appointment.update({ where: { id: oldGeneral }, data: { status: "CANCELED", cancelReason: "OTHER" } });
  r = await decideC(pw.rid, "approve", pw.aid);
  ok("P11a …once that one is gone, the approval goes through (APPROVED, CONFIRMED)", r.status === 200
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" r JOIN "Appointment" a ON a.id = r."appointmentId" WHERE r.id = ${pw.rid} AND r.status = 'APPROVED' AND a.status = 'CONFIRMED'`)) === 1, String(r.status));

  // The per-phone cap counts a phone's live AUTO bookings (the business's own setting: 2).
  const autoAt = (hhmm: string, d: number, ph: string, k: string = key()) => subC({ serviceId: autoC, startsAt: at(hhmm, W(d)), name: "אוטומטי", phone: ph }, k);
  const px = phone();
  const kx1 = key();
  const x1 = await autoAt("09:00", 3, px, kx1);
  const x1b = await body(x1);
  const x2 = await autoAt("11:00", 3, px);
  const x2b = await body(x2);
  cBefore = await apptsC();
  const x3 = await autoAt("13:00", 3, px);
  const x3b = await body(x3);
  ok("P12 two AUTO bookings from one phone: CONFIRMED; the third → 429 REQUEST_LIMIT, nothing written (was unlimited)",
    x1.status === 201 && x1b?.status === "CONFIRMED" && x2.status === 201 && x2b?.status === "CONFIRMED" && x3.status === 429 && x3b?.error === "REQUEST_LIMIT" && (await apptsC()) === cBefore,
    `${x1.status} ${x2.status} ${x3.status}`);
  r = await autoAt("09:00", 3, px, kx1);
  ok("P13 the first booking sent again with its own key while at the cap → 200 replayed (not 429), nothing new", r.status === 200 && (await body(r))?.replayed === true && (await apptsC()) === cBefore);
  const py = phone();
  await subC({ serviceId: cutC, startsAt: at("09:00", W(4)), name: "ממתין", phone: py });
  await subC({ serviceId: cutC, startsAt: at("09:30", W(4)), name: "ממתין", phone: py });
  const y3 = await subC({ serviceId: cutC, startsAt: at("10:00", W(4)), name: "ממתין", phone: py });
  const y3b = await body(y3);
  ok("P14 the refusal reads the same whether the phone is at its cap through waiting requests or AUTO bookings — no count, no times, no phone",
    y3.status === 429 && JSON.stringify(y3b) === JSON.stringify(x3b) && !JSON.stringify(x3b).includes(px.slice(2)) && !/\d{2}:\d{2}/.test(JSON.stringify(x3b)), JSON.stringify(x3b));
  r = await routes.manage.POST(req("/api/public/booking/manage", { method: "POST", body: { token: x2b.manageToken, action: "cancel" } }));
  const p15c = r.status;
  r = await autoAt("13:00", 3, px);
  ok("P15 a cancelled AUTO booking no longer counts: after the customer cancels one, the next → 201", p15c === 200 && r.status === 201, `${p15c} ${r.status}`);
  const x1appt = await reqAt(at("09:00", W(3)));
  const longAgo = new Date(Date.now() - 3 * 24 * 3600_000);
  await owner.appointment.update({ where: { id: x1appt.aid }, data: { startsAt: longAgo, endsAt: new Date(longAgo.getTime() + 3600_000) } });
  r = await autoAt("15:00", 3, px);
  const p16a = r.status;
  r = await autoAt("16:00", 3, px);
  ok("P16 a past AUTO booking no longer counts (one live left → one more 201, then 429)", p16a === 201 && r.status === 429, `${p16a} ${r.status}`);
  const pz = phone();
  await subC({ serviceId: cutC, startsAt: at("11:00", W(4)), name: "החלטות", phone: pz });
  const pzd = await reqAt(at("11:00", W(4)));
  const pzDecline = await decideC(pzd.rid, "decline", pzd.aid);
  await subC({ serviceId: cutC, startsAt: at("11:30", W(4)), name: "החלטות", phone: pz });
  const pza = await reqAt(at("11:30", W(4)));
  const pzApprove = await decideC(pza.rid, "approve", pza.aid);
  const z1 = await autoAt("13:00", 4, pz), z2 = await autoAt("14:00", 4, pz), z3 = await autoAt("15:00", 4, pz);
  ok("P17 a declined request and an owner-approved booking are not counted; two AUTO, then 429",
    pzDecline.status === 200 && pzApprove.status === 200 && z1.status === 201 && z2.status === 201 && z3.status === 429, `${pzDecline.status} ${pzApprove.status} ${z1.status} ${z2.status} ${z3.status}`);
  const pv = phone();
  const burstAuto = await Promise.all(["11:00", "12:00", "13:00", "14:00", "15:00", "16:00"].map((t) => autoAt(t, 2, pv)));
  ok("P18 six AUTO bookings from one phone at once (six free times) → exactly two 201, four 429 REQUEST_LIMIT", burstAuto.filter((x) => x.status === 201).length === 2
    && burstAuto.filter((x) => x.status === 429).length === 4
    && (await n(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE "businessId" = ${bizC} AND "contactPhone" = '972${pv.slice(1)}'`)) === 2, burstAuto.map((x) => x.status).join(","));
  // Isolation: px is at its cap in C; in business A (straight through the service, past the route's per-business
  // ceiling that the sections above used up) the same phone books freely.
  const { submitPublicRequest } = await import("@/lib/services/booking/public-booking.service");
  const atCapInC = await autoAt("16:00", 4, px);
  const inA = await submitPublicRequest(newId, { serviceId: color, startsAt: at("09:00", W(0)), name: "בעסק אחר", phone: px }, key()).then((x) => x.status, (e) => (e as { code?: string }).code);
  ok("P19 isolation: the phone at its cap in C (429 there) books in business A (CONFIRMED)", atCapInC.status === 429 && inA === "CONFIRMED", `${atCapInC.status} ${inA}`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); });
