/**
 * Recurring appointments (G5), arrival / correction (G6) and the setup wizard's server (G9) — end to end on a real
 * database AS THE RESTRICTED RUNTIME (app_runtime_prod: NOSUPERUSER NOBYPASSRLS), over migration
 * 20261226090000_appointments_completion applied by `prisma migrate deploy` on Production's role topology
 * (`.apc/lab.sh <db> --with-apc`). The owner role (BYPASSRLS) writes fixtures and reads back only.
 *
 *   A. HTTP edge: the new routes are 404 with the flag OFF, 401 without a session; ON for business A only.
 *   P. Preview: taken and closed days reported, nothing written.
 *   C. Create: the series row and every bookable occurrence (seriesId, seriesIndex), the skipped ones reported (their
 *      index unused), the journal (APPOINTMENT_CREATED each + SERIES_CREATED with the request key), replay / reuse of
 *      the key, nothing bookable ⇒ SLOT_CONFLICT and nothing written; the DB refuses an open-ended series.
 *   K. Concurrency: simultaneous series creations over the same times never double-book (one per slot, the rest
 *      skipped or refused — never a 500), and the database holds no overlapping active pair.
 *   T. Tenant isolation: business B cannot read, change or reference A's series, staff, customers or occurrences —
 *      through the service, and through raw SQL as the runtime under its own tenant context.
 *   S. Series changes: cancel one / following (rule truncated, version bumped, SERIES_CHANGED), stale version refused,
 *      move one (a taken time refused), move following (skips reported, the rule SPLIT), move from the first (rule
 *      changed in place).
 *   G. Arrival (actualStartedAt, ARRIVED, too early / twice refused, lateness computed) and status correction
 *      (STATUS_CORRECTED with its closed reason, only lifecycle targets, a re-opened cancellation re-checked).
 *   W. Setup wizard: needsSetup only when empty; written once; never overwrites (kept); two concurrent submits do not
 *      double the services; another business untouched.
 *   E. Erasure: the account-deletion line clears the series' title and customer as the runtime.
 *
 * env: OWNER_URL (lab_owner), DATABASE_URL / DIRECT_URL (app_runtime_prod). Synthetic only. ZERO network.
 * Run: npx tsx lib/services/appointment/appointment-series.db.test.ts
 */
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "apc-e-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "apc-e-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtimeRaw = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const n = async (sql: string) => Number(((await owner.$queryRawUnsafe(sql)) as { n: number }[])[0].n);
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e)); }
}

async function main() {
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { signAuthToken } = await import("@/lib/auth-token");
  const series = await import("@/lib/services/appointment/appointment-series.service");
  const arrival = await import("@/lib/services/appointment/appointment-arrival.service");
  const setup = await import("@/lib/services/appointment/calendar-setup.service");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const { lateness } = await import("@/lib/services/appointment/appointment-arrival.core");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { weekdayOf } = await import("@/lib/services/appointment/availability.core");
  const routes = {
    series: await import("@/app/api/appointments/series/route"),
    preview: await import("@/app/api/appointments/series/preview/route"),
    one: await import("@/app/api/appointments/series/[seriesId]/route"),
    arrival: await import("@/app/api/appointments/[id]/arrival/route"),
    setup: await import("@/app/api/appointments/setup/route"),
  };

  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const tag = `apc-e-${Date.now()}`;
  const mk = async (s: string) => {
    const biz = (await owner.business.create({ data: { name: `${tag}-${s}` } })).id;
    const user = (await owner.user.create({ data: { email: `${tag}-${s}@lab.test`, password: "x", businessId: biz } })).id;
    return { biz, user, principal: { kind: "OWNER" as const, businessId: biz, userId: user } };
  };
  const A = await mk("a");
  const B = await mk("b");
  const C = await mk("c"); // empty calendar (setup wizard)
  const D = await mk("d"); // hours only (setup wizard never overwrites)
  const svcA = (await owner.businessService.create({ data: { businessId: A.biz, name: "טיפול פנים", type: "SERVICE", durationMinutes: 60 } })).id;
  const custA = (await owner.customer.create({ data: { businessId: A.biz, name: "דנה כהן" } })).id;
  const custB = (await owner.customer.create({ data: { businessId: B.biz, name: "לקוחה ב" } })).id;
  const staffA = (await owner.staffMember.create({ data: { businessId: A.biz, displayName: "רוני" } })).id;
  const staffB = (await owner.staffMember.create({ data: { businessId: B.biz, displayName: "עובד ב" } })).id;
  for (const wd of [0, 1, 2, 3, 4]) await owner.availabilityRule.create({ data: { businessId: A.biz, weekday: wd, startMinute: 540, endMinute: 1140 } });
  await owner.availabilityRule.create({ data: { businessId: D.biz, weekday: 2, startMinute: 600, endMinute: 660 } });

  // The first Tuesday at least 14 days ahead (Israel time); 12 weekly Tuesdays from it.
  let TUE = addCalendarDays(jerusalemDayKey(new Date()), 14);
  while (weekdayOf(TUE) !== 2) TUE = addCalendarDays(TUE, 1);
  const week = (i: number) => addCalendarDays(TUE, 7 * i);
  const at = (day: string, h: number, m = 0) => jerusalemInstantAt(day, h, m);
  console.log(`  (series from ${TUE})`);
  const key = () => uuidV7(new Date());
  const ownerAppt = async (biz: number, user: number, startsAt: Date, minutes: number, extra: Record<string, unknown> = {}) =>
    (await owner.appointment.create({
      data: { businessId: biz, status: "CONFIRMED", kind: "CUSTOMER", startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60000), durationMinutes: minutes, createdByActor: "OWNER", sourceChannel: "INBOX_WEB", createdByUserId: user, ...extra },
    })).id;
  // An appointment of A on week 2 at 10:30 (blocks the 10:00–11:00 occurrence); a closed day on week 4.
  const blocker = await ownerAppt(A.biz, A.user, at(week(2), 10, 30), 30);
  await owner.availabilityException.create({ data: { businessId: A.biz, dayKey: new Date(`${week(4)}T00:00:00.000Z`), kind: "CLOSED" } });

  const base = { kind: "CUSTOMER", startsAt: at(TUE, 10).toISOString(), businessServiceId: svcA, customerId: custA, frequency: "WEEKLY", occurrenceCount: 12 };

  // ── A. HTTP edge ───────────────────────────────────────────────────────────────────────────────
  console.log("A. the HTTP edge (flag, session)");
  const BASE = "https://app.example.com";
  const tokenA = signAuthToken(A.user, 0);
  const tokenB = signAuthToken(B.user, 0);
  const req = (path: string, init: { method?: string; body?: unknown; key?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = init.token === undefined ? tokenA : init.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  let r = await routes.preview.POST(req("/api/appointments/series/preview", { method: "POST", body: base }));
  ok("A1 flag OFF → 404 for the signed-in owner", r.status === 404, String(r.status));
  r = await routes.setup.GET(req("/api/appointments/setup", { token: null }));
  ok("A2 no session → 401", r.status === 401, String(r.status));
  await owner.businessFeatureAccess.create({ data: { businessId: A.biz, featureKey: "appointments", state: "ENABLED", reason: "lab" } });
  r = await routes.preview.POST(req("/api/appointments/series/preview", { method: "POST", body: base }));
  const pv = await r.json();
  ok("A3 flag ON for A → preview 200", r.status === 200 && pv.bookable === 10, `${r.status} ${JSON.stringify(pv).slice(0, 200)}`);
  r = await routes.setup.GET(req("/api/appointments/setup", { token: tokenB }));
  ok("A4 still 404 for business B", r.status === 404, String(r.status));
  r = await routes.series.POST(req("/api/appointments/series", { method: "POST", body: base }));
  ok("A5 a write without Idempotency-Key → 400, nothing written", r.status === 400 && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${A.biz}`)) === 0, String(r.status));

  // ── P. Preview ─────────────────────────────────────────────────────────────────────────────────
  console.log("P. preview");
  const preview = await series.previewSeries(A.principal, base);
  ok("P1 12 planned, 10 bookable", preview.occurrences.length === 12 && preview.bookable === 10 && preview.skipped === 2);
  ok("P2 week 2 taken (CONFLICT), week 4 closed (CLOSED)",
    preview.occurrences[2].reason === "CONFLICT" && preview.occurrences[4].reason === "CLOSED" && preview.occurrences.filter((o) => !o.ok).length === 2);
  ok("P3 the preview wrote nothing", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${A.biz} AND "seriesId" IS NOT NULL`)) === 0);

  // ── C. Create ──────────────────────────────────────────────────────────────────────────────────
  console.log("C. create");
  const k1 = key();
  const made = await series.createSeries(A.principal, { idempotencyKey: k1 }, base);
  const sid = made.series.id;
  ok("C1 10 occurrences created, 2 skipped and reported", made.occurrences.length === 10 && made.skipped.length === 2
    && made.skipped.map((x) => `${x.index}:${x.reason}`).join(",") === "2:CONFLICT,4:CLOSED", JSON.stringify(made.skipped));
  ok("C2 the series row: weekly, Tuesday, 10:00, 60 min, 12 occurrences, version 1, the owner's user",
    made.series.frequency === "WEEKLY" && made.series.weekday === 2 && made.series.startMinute === 600 && made.series.durationMinutes === 60
    && made.series.occurrenceCount === 12 && made.series.endsOn === null && made.series.version === 1 && made.series.createdByUserId === A.user);
  ok("C3 skipped indexes stay unused (0,1,3,5..11)", made.occurrences.map((o) => o.seriesIndex).join(",") === "0,1,3,5,6,7,8,9,10,11");
  ok("C4 every occurrence is a normal timed CONFIRMED appointment of A at 10:00 local, with the service and customer",
    (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${sid} AND "businessId" = ${A.biz} AND status = 'CONFIRMED'
      AND "customerId" = ${custA} AND "businessServiceId" = ${svcA} AND "durationMinutes" = 60 AND "createdByActor" = 'OWNER' AND "createdByUserId" = ${A.user}
      AND to_char("startsAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '10:00'`)) === 10);
  ok("C5 journal: 10 APPOINTMENT_CREATED + ONE SERIES_CREATED carrying the request key",
    (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" e JOIN "Appointment" a ON a.id = e."appointmentId" WHERE a."seriesId" = ${sid} AND e."eventType" = 'APPOINTMENT_CREATED'`)) === 10
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = ${A.biz} AND "eventType" = 'SERIES_CREATED' AND "idempotencyKey" = '${k1}' AND "requestDigest" IS NOT NULL`)) === 1);
  const again = await series.createSeries(A.principal, { idempotencyKey: k1 }, base);
  ok("C6 same key + same body → replayed, nothing new", again.replayed && again.series.id === sid && again.skipped.length === 2
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${A.biz}`)) === 1);
  ok("C7 same key + another body → IDEMPOTENCY_KEY_REUSED", (await code(series.createSeries(A.principal, { idempotencyKey: k1 }, { ...base, occurrenceCount: 3 }))) === "IDEMPOTENCY_KEY_REUSED");
  ok("C8 the same series again (all taken now) → SLOT_CONFLICT, nothing written",
    (await code(series.createSeries(A.principal, { idempotencyKey: key() }, base))) === "SLOT_CONFLICT"
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${A.biz}`)) === 1);
  ok("C9 open-ended (no count, no date) refused before any write", (await code(series.createSeries(A.principal, { idempotencyKey: key() }, { ...base, occurrenceCount: undefined }))) === "INVALID_INPUT");
  ok("C10 105 occurrences refused", (await code(series.createSeries(A.principal, { idempotencyKey: key() }, { ...base, occurrenceCount: 105 }))) === "INVALID_INPUT");
  const openEnded = await runtimeRaw.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${A.biz}', true)`);
    return tx.$executeRawUnsafe(`INSERT INTO "AppointmentSeries" ("businessId", frequency, weekday, "startMinute", "durationMinutes", "startsOn", "updatedAt") VALUES (${A.biz}, 'WEEKLY', 2, 600, 60, CURRENT_DATE, now())`);
  }).then(() => "OK", (e: Error) => e.message);
  ok("C11 the database itself refuses an open-ended series (AppointmentSeries_end)", /AppointmentSeries_end|check constraint/i.test(openEnded), openEnded.slice(0, 120));
  const bi = await series.createSeries(A.principal, { idempotencyKey: key() }, { kind: "INTERNAL", title: "ישיבת צוות", startsAt: at(TUE, 8).toISOString(), durationMinutes: 30, frequency: "BIWEEKLY", endsOn: week(6) });
  ok("C12 bi-weekly until a date: weeks 0,2,6 booked, week 4 closed (skipped), outside the hours → warned, not refused",
    bi.occurrences.length === 3 && bi.skipped.map((x) => `${x.index}:${x.reason}`).join() === "2:CLOSED" && bi.series.occurrenceCount === null && bi.series.endsOn !== null && bi.warnings.includes("OUTSIDE_AVAILABILITY"), JSON.stringify({ n: bi.occurrences.length, w: bi.warnings, s: bi.skipped }));

  // ── K. Concurrency ─────────────────────────────────────────────────────────────────────────────
  console.log("K. concurrency — simultaneous series never double-book");
  const kBody = { kind: "INTERNAL", title: "חפיפה", startsAt: at(TUE, 15).toISOString(), durationMinutes: 45, staffMemberId: staffA, frequency: "WEEKLY", occurrenceCount: 6 };
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
    series.createSeries(A.principal, { idempotencyKey: key() }, { ...kBody, startsAt: at(TUE, 15, i % 2 === 0 ? 0 : 15).toISOString() })));
  const fulfilled = results.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof series.createSeries>>>[];
  const rejected = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
  ok("K1 exactly one series wins the slots; the rest are SLOT_CONFLICT (no 500)",
    fulfilled.length === 1 && rejected.length === 5 && rejected.every((x) => (x.reason as { code?: string }).code === "SLOT_CONFLICT"),
    `${fulfilled.length} ok, ${rejected.map((x) => (x.reason as { code?: string }).code ?? String(x.reason)).join(",")}`);
  ok("K2 the database holds NO overlapping active pair in any lane of A",
    (await n(`SELECT count(*)::int AS n FROM "Appointment" x JOIN "Appointment" y ON x."businessId" = y."businessId" AND x.id < y.id
      AND (x."staffMemberId" IS NOT DISTINCT FROM y."staffMemberId" OR x."staffMemberId" IS NULL OR y."staffMemberId" IS NULL)
      AND x.status IN ('PROPOSED','CONFIRMED') AND y.status IN ('PROPOSED','CONFIRMED') AND x."endsAt" IS NOT NULL AND y."endsAt" IS NOT NULL
      AND tsrange(x."startsAt" - x."bufferBeforeMinutes" * interval '1 minute', x."endsAt" + x."bufferAfterMinutes" * interval '1 minute')
       && tsrange(y."startsAt" - y."bufferBeforeMinutes" * interval '1 minute', y."endsAt" + y."bufferAfterMinutes" * interval '1 minute')
      WHERE x."businessId" = ${A.biz}`)) === 0);
  // Two series that overlap only partly (every other week): both succeed, the second skips the shared days.
  const [p1, p2] = await Promise.all([
    series.createSeries(A.principal, { idempotencyKey: key() }, { kind: "BLOCK", startsAt: at(TUE, 17).toISOString(), durationMinutes: 30, frequency: "WEEKLY", occurrenceCount: 4 }),
    series.createSeries(A.principal, { idempotencyKey: key() }, { kind: "BLOCK", startsAt: at(TUE, 17).toISOString(), durationMinutes: 30, frequency: "BIWEEKLY", occurrenceCount: 4 }),
  ].map((x) => x.then((v) => v, (e) => e)));
  const okOnes = [p1, p2].filter((x) => x && x.series);
  const total17 = okOnes.reduce((sum, x) => sum + x.occurrences.length, 0);
  ok("K3 partly-overlapping simultaneous series: every shared day booked once, the other one skipped",
    (await n(`SELECT count(*)::int AS n FROM (SELECT "startsAt" FROM "Appointment" WHERE "businessId" = ${A.biz} AND kind = 'BLOCK' AND status = 'CONFIRMED'
      AND to_char("startsAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '17:00' GROUP BY "startsAt" HAVING count(*) > 1) d`)) === 0
    && total17 === (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${A.biz} AND kind = 'BLOCK' AND to_char("startsAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '17:00'`)),
    `total ${total17}`);

  // ── T. Tenant isolation ────────────────────────────────────────────────────────────────────────
  console.log("T. tenant isolation");
  ok("T1 B cannot read A's series (NOT_FOUND)", (await code(series.getSeries(B.principal, sid))) === "NOT_FOUND");
  ok("T2 B cannot cancel A's series (NOT_FOUND) and nothing changed",
    (await code(series.changeSeries(B.principal, { idempotencyKey: key() }, sid, { action: "cancel", scope: "following", appointmentId: made.occurrences[0].id }))) === "NOT_FOUND"
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${sid} AND status = 'CANCELED'`)) === 0);
  ok("T3 B cannot move A's occurrence through B's own series id path (NOT_FOUND)",
    (await code(series.changeSeries(B.principal, { idempotencyKey: key() }, sid, { action: "move", scope: "one", appointmentId: made.occurrences[0].id, startsAt: at(TUE, 12).toISOString() }))) === "NOT_FOUND");
  ok("T4 B cannot book a series naming A's staff (STAFF_NOT_FOUND) or A's customer (CUSTOMER_NOT_FOUND)",
    (await code(series.createSeries(B.principal, { idempotencyKey: key() }, { kind: "INTERNAL", title: "x", startsAt: at(TUE, 10).toISOString(), durationMinutes: 30, staffMemberId: staffA, frequency: "WEEKLY", occurrenceCount: 2 }))) === "STAFF_NOT_FOUND"
    && (await code(series.createSeries(B.principal, { idempotencyKey: key() }, { ...base, businessServiceId: undefined, durationMinutes: 30, customerId: custA, occurrenceCount: 2 }))) === "CUSTOMER_NOT_FOUND");
  const bSeries = await series.createSeries(B.principal, { idempotencyKey: key() }, { kind: "CUSTOMER", customerId: custB, staffMemberId: staffB, startsAt: at(TUE, 10).toISOString(), durationMinutes: 60, frequency: "WEEKLY", occurrenceCount: 3 });
  ok("T5 A's busy time is invisible to B: B books the same Tuesdays at 10:00 in full", bSeries.occurrences.length === 3 && bSeries.skipped.length === 0);
  ok("T6 A cannot change B's series, nor change A's series naming B's occurrence (NOT_FOUND)",
    (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, bSeries.series.id, { action: "cancel", scope: "one", appointmentId: bSeries.occurrences[0].id }))) === "NOT_FOUND"
    && (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "cancel", scope: "one", appointmentId: bSeries.occurrences[0].id }))) === "NOT_FOUND");
  const asB = <T,>(fn: (tx: Parameters<Parameters<typeof runtimeRaw.$transaction>[0]>[0]) => Promise<T>) => runtimeRaw.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${B.biz}', true)`);
    return fn(tx);
  });
  const seen = await asB((tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${A.biz}`) as Promise<{ n: number }[]>);
  const upd = await asB((tx) => tx.$executeRawUnsafe(`UPDATE "AppointmentSeries" SET title = 'x' WHERE id = ${sid}`));
  const noCtx = await runtimeRaw.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AppointmentSeries"`) as { n: number }[];
  ok("T7 as the runtime under B's context: A's series invisible (RLS), an UPDATE touches 0 rows; no context → nothing visible",
    seen[0].n === 0 && upd === 0 && noCtx[0].n === 0, JSON.stringify({ seen, upd, noCtx }));
  const crossFk = await asB((tx) => tx.$executeRawUnsafe(`UPDATE "Appointment" SET "seriesId" = ${sid}, "seriesIndex" = 50 WHERE id = ${bSeries.occurrences[0].id}`)).then(() => "OK", (e: Error) => e.message);
  ok("T8 B's occurrence cannot be pointed at A's series (composite tenant FK)", /foreign key|23503|violates/i.test(crossFk), crossFk.slice(0, 120));

  // ── S. Series changes ──────────────────────────────────────────────────────────────────────────
  console.log("S. this occurrence / this and following");
  const occ = made.occurrences; // indexes 0,1,3,5,6,7,8,9,10,11
  ok("S1 a stale series version → VERSION_CONFLICT, nothing changed",
    (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "cancel", scope: "one", appointmentId: occ[1].id, expectedVersion: 7 }))) === "VERSION_CONFLICT");
  const c1 = await series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "cancel", scope: "one", appointmentId: occ[1].id, expectedVersion: 1, cancelReason: "CUSTOMER_CANCELED" });
  ok("S2 cancel ONE: only that occurrence, the rule untouched, version 2, SERIES_CHANGED journalled",
    c1.changed === 1 && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${sid} AND status = 'CANCELED'`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${sid} AND version = 2 AND "occurrenceCount" = 12 AND "endsOn" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${occ[1].id} AND "eventType" IN ('APPOINTMENT_CANCELED','SERIES_CHANGED')`)) === 2);
  ok("S3 a cancelled occurrence cannot be the start of a change (INVALID_TRANSITION)",
    (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "cancel", scope: "following", appointmentId: occ[1].id }))) === "INVALID_TRANSITION");
  // Move ONE onto the blocker's time → refused; onto free time → moved.
  ok("S4 move ONE onto taken time → SLOT_CONFLICT, nothing moved",
    (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "move", scope: "one", appointmentId: occ[0].id, startsAt: at(week(2), 10).toISOString() }))) === "SLOT_CONFLICT");
  const m1 = await series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "move", scope: "one", appointmentId: occ[0].id, startsAt: at(TUE, 12).toISOString(), expectedVersion: 2 });
  ok("S5 move ONE to free time: moved, APPOINTMENT_RESCHEDULED + SERIES_CHANGED, version 3",
    m1.changed === 1 && m1.appointment.startsAt?.getTime() === at(TUE, 12).getTime()
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${sid} AND version = 3`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${occ[0].id} AND "eventType" = 'APPOINTMENT_RESCHEDULED'`)) === 1);
  // Move FOLLOWING from index 5 (occ[3]) to Wednesday 13:00; put a blocker on week 7's new time.
  const wedBlocker = await ownerAppt(A.biz, A.user, at(addCalendarDays(week(7), 1), 13), 60);
  const mf = await series.changeSeries(A.principal, { idempotencyKey: key() }, sid, { action: "move", scope: "following", appointmentId: occ[3].id, startsAt: at(addCalendarDays(week(5), 1), 13).toISOString(), expectedVersion: 3 });
  const split = mf.toSeriesId;
  ok("S6 move FOLLOWING: 6 moved to Wednesday 13:00, week 7 (taken) kept its time and is reported",
    mf.changed === 6 && mf.skipped.length === 1 && mf.skipped[0].reason === "CONFLICT" && mf.skipped[0].dayKey === addCalendarDays(week(7), 1), JSON.stringify(mf));
  ok("S7 …the rule SPLIT: the old series ends the day before week 5 (no count), the new one starts Wednesday week 5, 7 remaining",
    split !== sid
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${sid} AND "endsOn" = '${addCalendarDays(week(5), -1)}' AND "occurrenceCount" IS NULL AND version = 4`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${split} AND "businessId" = ${A.biz} AND weekday = 3 AND "startMinute" = 780 AND "startsOn" = '${addCalendarDays(week(5), 1)}' AND "occurrenceCount" = 7`)) === 1);
  ok("S8 …occurrences from index 5 re-pointed and re-indexed from 0; the earlier ones stay",
    (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${split}`)) === 7
    && (await n(`SELECT min("seriesIndex")::int AS n FROM "Appointment" WHERE "seriesId" = ${split}`)) === 0
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${sid}`)) === 3);
  ok("S9 the blocker on Wednesday week 7 untouched", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${wedBlocker} AND status = 'CONFIRMED'`)) === 1);
  const splitSum = await series.getSeries(A.principal, split);
  // Cancel FOLLOWING from the split's 3rd occurrence → the split series ends before it.
  const third = splitSum.occurrences.find((o) => o.seriesIndex === 3)!;
  const cf = await series.changeSeries(A.principal, { idempotencyKey: key() }, split, { action: "cancel", scope: "following", appointmentId: third.id, expectedVersion: 1 });
  ok("S10 cancel FOLLOWING: every active occurrence from it on cancelled, the rule ends the day before",
    cf.changed === 4 && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "seriesId" = ${split} AND "seriesIndex" >= 3 AND status IN ('PROPOSED','CONFIRMED')`)) === 0
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${split} AND "endsOn" IS NOT NULL AND "occurrenceCount" IS NULL AND "cancelledAt" IS NULL AND version = 2`)) === 1, JSON.stringify(cf));
  const first = splitSum.occurrences.find((o) => o.seriesIndex === 0)!;
  const cAll = await series.changeSeries(A.principal, { idempotencyKey: key() }, split, { action: "cancel", scope: "following", appointmentId: first.id });
  ok("S11 cancel FOLLOWING from the first occurrence → the whole series cancelled (cancelledAt), further changes refused",
    cAll.changed === 3 && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${split} AND "cancelledAt" IS NOT NULL`)) === 1
    && (await code(series.changeSeries(A.principal, { idempotencyKey: key() }, split, { action: "cancel", scope: "one", appointmentId: first.id }))) === "INVALID_TRANSITION");
  // Move FOLLOWING from the first occurrence of B's series → the rule changes in place (no split).
  const mb = await series.changeSeries(B.principal, { idempotencyKey: key() }, bSeries.series.id, { action: "move", scope: "following", appointmentId: bSeries.occurrences[0].id, startsAt: at(TUE, 11).toISOString(), durationMinutes: 30 });
  ok("S12 move FOLLOWING from the first: the rule changes in place (11:00, 30 min), no new series",
    mb.toSeriesId === bSeries.series.id && mb.changed === 3
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${bSeries.series.id} AND "startMinute" = 660 AND "durationMinutes" = 30 AND version = 2`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${B.biz}`)) === 1);
  const k2 = key();
  const m2a = await series.changeSeries(B.principal, { idempotencyKey: k2 }, bSeries.series.id, { action: "cancel", scope: "one", appointmentId: bSeries.occurrences[2].id });
  const m2b = await series.changeSeries(B.principal, { idempotencyKey: k2 }, bSeries.series.id, { action: "cancel", scope: "one", appointmentId: bSeries.occurrences[2].id });
  ok("S13 a repeated change request (same key) is replayed, not applied twice", !m2a.replayed && m2b.replayed
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE id = ${bSeries.series.id} AND version = 3`)) === 1);

  // ── G. Arrival and correction ──────────────────────────────────────────────────────────────────
  console.log("G. arrival, lateness, status correction");
  const now = new Date();
  const roundMin = (d: Date) => new Date(Math.floor(d.getTime() / 60000) * 60000);
  const soon = await schedule.createAppointment(A.principal, { idempotencyKey: key() }, { kind: "CUSTOMER", customerId: custA, startsAt: roundMin(new Date(now.getTime() + 5 * 3600_000)).toISOString(), durationMinutes: 30, staffMemberId: staffA });
  ok("G1 5 hours before the start → INVALID_TRANSITION (TOO_EARLY)", (await code(arrival.markArrived(A.principal, { idempotencyKey: key() }, soon.appointment.id, {}))) === "INVALID_TRANSITION");
  const started = await schedule.createAppointment(A.principal, { idempotencyKey: key() }, { kind: "CUSTOMER", customerId: custA, startsAt: roundMin(new Date(now.getTime() - 12 * 60000)).toISOString(), durationMinutes: 30, staffMemberId: staffA });
  ok("G2 lateness before arrival: 'late' (computed, nothing stored)", lateness({ ...started.appointment }, new Date()).state === "late" && started.appointment.actualStartedAt === null);
  const arrived = await arrival.markArrived(A.principal, { idempotencyKey: key() }, started.appointment.id, { expectedVersion: started.appointment.version });
  ok("G3 ARRIVED: actualStartedAt stamped, status still CONFIRMED, version +1, journalled",
    arrived.appointment.actualStartedAt !== null && arrived.appointment.status === "CONFIRMED" && arrived.appointment.version === started.appointment.version + 1
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${started.appointment.id} AND "eventType" = 'ARRIVED' AND actor = 'OWNER_USER' AND "actorUserId" = ${A.user}`)) === 1);
  ok("G4 lateness after arrival: 'arrived_late' ≈ 12 min", (() => { const l = lateness(arrived.appointment, new Date()); return l.state === "arrived_late" && l.minutes >= 11 && l.minutes <= 14; })());
  ok("G5 arriving twice → INVALID_TRANSITION", (await code(arrival.markArrived(A.principal, { idempotencyKey: key() }, started.appointment.id, {}))) === "INVALID_TRANSITION");
  ok("G6 B cannot mark A's appointment (NOT_FOUND)", (await code(arrival.markArrived(B.principal, { idempotencyKey: key() }, soon.appointment.id, {}))) === "NOT_FOUND");
  const done = await schedule.changeStatus(A.principal, { idempotencyKey: key() }, started.appointment.id, { to: "COMPLETED" });
  ok("G7 a live status is not corrected (CONFIRMED → COMPLETED via correction refused)",
    (await code(arrival.correctStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "COMPLETED", reasonCode: "WRONG_MARK" }))) === "INVALID_TRANSITION");
  ok("G8 a free-text reason code is refused (closed tokens only)",
    (await code(arrival.correctStatus(A.principal, { idempotencyKey: key() }, started.appointment.id, { to: "NO_SHOW", reasonCode: "she was late" }))) === "INVALID_INPUT");
  const fixed = await arrival.correctStatus(A.principal, { idempotencyKey: key() }, started.appointment.id, { to: "NO_SHOW", reasonCode: "CUSTOMER_DID_NOT_COME", note: "התבלבלתי", expectedVersion: done.appointment.version });
  ok("G9 COMPLETED → NO_SHOW: STATUS_CORRECTED {from,to,reasonCode}, the arrival cleared, the note kept, sensor recorded",
    fixed.appointment.status === "NO_SHOW" && fixed.appointment.actualStartedAt === null && (fixed.appointment.notes ?? "").includes("התבלבלתי")
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "appointmentId" = ${started.appointment.id} AND "eventType" = 'STATUS_CORRECTED'
        AND payload->>'from' = 'COMPLETED' AND payload->>'to' = 'NO_SHOW' AND payload->>'reasonCode' = 'CUSTOMER_DID_NOT_COME'`)) === 1);
  // Cancel the future one, book its time with another appointment, then try to re-open it → refused (never forced).
  const cancelled = await schedule.changeStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "CANCELED" });
  const taker = await schedule.createAppointment(A.principal, { idempotencyKey: key() }, { kind: "INTERNAL", title: "x", startsAt: soon.appointment.startsAt!.toISOString(), durationMinutes: 30, staffMemberId: staffA });
  ok("G10 re-opening a cancellation whose time is now taken → SLOT_CONFLICT, still CANCELED",
    (await code(arrival.correctStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "CONFIRMED", reasonCode: "NOT_CANCELED" }))) === "SLOT_CONFLICT"
    && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${soon.appointment.id} AND status = 'CANCELED'`)) === 1);
  await schedule.changeStatus(A.principal, { idempotencyKey: key() }, taker.appointment.id, { to: "CANCELED" });
  const reopened = await arrival.correctStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "CONFIRMED", reasonCode: "NOT_CANCELED", expectedVersion: cancelled.appointment.version });
  ok("G11 …once free: re-opened as CONFIRMED, cancel reason cleared", reopened.appointment.status === "CONFIRMED" && reopened.appointment.cancelReason === null);
  await schedule.changeStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "CANCELED" });
  let g12 = "";
  try { await arrival.correctStatus(A.principal, { idempotencyKey: key() }, soon.appointment.id, { to: "COMPLETED", reasonCode: "OTHER" }); g12 = "OK"; }
  catch (e) { g12 = `${(e as { code?: string }).code}:${String((e as { details?: { reason?: string } }).details?.reason)}`; }
  ok("G12 an outcome before the start is refused by the correction too (NOT_STARTED)", g12 === "INVALID_TRANSITION:NOT_STARTED", g12);

  // ── W. Setup wizard ────────────────────────────────────────────────────────────────────────────
  console.log("W. the setup wizard's server");
  const stA = await setup.getSetupState(A.principal);
  const stC = await setup.getSetupState(C.principal);
  ok("W1 needsSetup: false for a configured calendar, true for an empty one", !stA.needsSetup && stC.needsSetup && !stC.hasHours && !stC.hasServices && !stC.hasStaff);
  const body = {
    hours: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1140 })).concat([{ weekday: 5, startMinute: 540, endMinute: 780 }]),
    services: [{ name: "תספורת גבר", durationMinutes: 30, priceAmount: 70 }, { name: "צבע", durationMinutes: 90 }],
    staff: [{ displayName: "מיכל" }],
  };
  const [w1, w2] = await Promise.all([setup.applySetup(C.principal, body), setup.applySetup(C.principal, body)]);
  ok("W2 two simultaneous submits: written once (one 'written', one 'kept' per part), never doubled",
    [w1.services, w2.services].sort().join() === "kept,written" && [w1.hours, w2.hours].sort().join() === "kept,written"
    && (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${C.biz}`)) === 2
    && (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${C.biz} AND "removedAt" IS NULL`)) === 6
    && (await n(`SELECT count(*)::int AS n FROM "StaffMember" WHERE "businessId" = ${C.biz}`)) === 1);
  ok("W3 a price only when given (FIXED 70; the other without a public price)",
    (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${C.biz} AND "priceMode" = 'FIXED' AND "priceAmount" = 70`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${C.biz} AND "priceMode" = 'NO_PUBLIC_PRICE' AND "priceAmount" IS NULL`)) === 1);
  const wD = await setup.applySetup(D.principal, { hours: body.hours, services: [{ name: "פגישה", durationMinutes: 30 }] });
  ok("W4 never overwrites: D's own hours kept exactly (one Tuesday window), its empty services written",
    wD.hours === "kept" && wD.services === "written" && wD.staff === "skipped"
    && (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${D.biz} AND "removedAt" IS NULL`)) === 1
    && (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${D.biz} AND weekday = 2 AND "startMinute" = 600 AND "endMinute" = 660 AND "removedAt" IS NULL`)) === 1);
  ok("W5 A's configuration untouched by C's and D's setup", (await n(`SELECT count(*)::int AS n FROM "AvailabilityRule" WHERE "businessId" = ${A.biz} AND "removedAt" IS NULL`)) === 5
    && (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${A.biz}`)) === 1);
  ok("W6 bad input refused before any write (a window ending before it starts; duplicate names)",
    (await code(setup.applySetup(B.principal, { hours: [{ weekday: 1, startMinute: 600, endMinute: 540 }] }))) === "INVALID_INPUT"
    && (await code(setup.applySetup(B.principal, { services: [{ name: "x", durationMinutes: 30 }, { name: "x", durationMinutes: 30 }] }))) === "INVALID_INPUT"
    && (await n(`SELECT count(*)::int AS n FROM "BusinessService" WHERE "businessId" = ${B.biz}`)) === 0);

  // ── E. Erasure ─────────────────────────────────────────────────────────────────────────────────
  console.log("E. erasure shape");
  await owner.appointmentSeries.update({ where: { id: sid }, data: { title: "סדרה עם שם" } });
  const erased = await runtimeRaw.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${A.biz}', true)`);
    return tx.appointmentSeries.updateMany({ where: { businessId: A.biz }, data: { title: null, customerId: null, erasedAt: new Date() } });
  });
  ok("E1 the adapter's line, as the runtime: every series of A cleared (title, customer), B untouched",
    erased.count >= 3 && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${A.biz} AND (title IS NOT NULL OR "customerId" IS NOT NULL OR "erasedAt" IS NULL)`)) === 0
    && (await n(`SELECT count(*)::int AS n FROM "AppointmentSeries" WHERE "businessId" = ${B.biz} AND "erasedAt" IS NULL AND "customerId" = ${custB}`)) === 1);
  void blocker;
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack : String(e)}`); console.error(e); })
  .finally(async () => {
    await owner.$disconnect();
    await runtimeRaw.$disconnect();
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
    process.exit(0);
  });
