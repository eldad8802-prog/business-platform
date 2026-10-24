/**
 * Appointments — what migration 20261029090000_appointments_foundation does, measured with the real role topology
 * on a Production-shaped database:
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane).
 *
 *   1. Isolation, four sides, per new table and on "Appointment", as the runtime: no context → nothing visible and
 *      every write refused; own rows visible; the other business's rows invisible and unchangeable; a write naming
 *      the other business refused; DELETE refused everywhere.
 *   2. Cross-business references refused by the database (staff, services, appointments, users).
 *   3. No overlap (decision 2): an overlapping active appointment of the same lane is refused; adjacent is allowed;
 *      buffers count; a cancelled appointment frees its time; lanes are separate; a block occupies its lane;
 *      appointments without an end time (every existing row, and both existing creation paths) are never refused.
 *   4. Concurrency: twelve simultaneous transactions claim the same slot — exactly one succeeds, eleven are refused
 *      by the constraint; twelve claiming twelve different lanes all succeed.
 *   5. Decision 6: an OWNER action needs a user; CUSTOMER / SYSTEM actions carry none; the journal names a user only
 *      for the owner's own actions.
 *   6. The journal is append-only (runtime and owner alike) and refuses free text.
 *   7. Account erasure refuses without a context and for an active business; for a business being deleted it nulls
 *      that business's acting users and digests only.
 *   8. The flags are OFF.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=24&pool_timeout=30`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 30_000 }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const OVERLAP = /Appointment_no_overlap|exclusion constraint|23P01/i;
const SAME_BIZ = /APPOINTMENT_USER_OTHER_BUSINESS|DZA03/;
const APPEND_ONLY = /APPOINTMENT_EVENT_APPEND_ONLY|DZA01/;
const ERASURE = /APPOINTMENT_ERASURE_|DZA04/;

let seq = 0;
const tok = (p = "k") => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;
const hex = (c: string) => c.repeat(64).slice(0, 64);

async function main() {
  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('appt-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('appt-B', now()) RETURNING "id"`);
  const user = (b: number, tag: string) =>
    mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${tok()}@appt.lab`, b);
  const userA = await user(bizA, "a");
  const userB = await user(bizB, "b");
  const service = (b: number) =>
    mk(`INSERT INTO "BusinessService" ("businessId", "name", "type", "updatedAt") VALUES ($1, 'תספורת', 'SERVICE', now()) RETURNING "id"`, b);
  const svcA = await service(bizA);
  const svcB = await service(bizB);
  const staff = (b: number, name: string) =>
    mk(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, $2, now()) RETURNING "id"`, b, name);
  const staffA = await staff(bizA, "דנה");
  const staffB = await staff(bizB, "יוסי");

  const apptSql = `INSERT INTO "Appointment" ("businessId", "createdByActor", "sourceChannel", "createdByUserId", "kind", "status",
                     "startsAt", "endsAt", "durationMinutes", "staffMemberId", "bufferBeforeMinutes", "bufferAfterMinutes", "updatedAt")
                   VALUES ($1, $2::"CreatedByActor", 'INBOX_WEB', $3, $4::"AppointmentKind", $5::"AppointmentStatus",
                     $6::timestamp, $7::timestamp, $8, $9, $10, $11, now()) RETURNING "id"`;
  type A = { biz: number; actor?: string; user?: number | null; kind?: string; status?: string; starts: string | null;
             ends: string | null; dur?: number | null; staff?: number | null; bb?: number; ba?: number };
  const appt = (client: PrismaClient, a: A) =>
    q(client, a.biz, apptSql, a.biz, a.actor ?? "OWNER", a.user === undefined ? (a.biz === bizA ? userA : userB) : a.user,
      a.kind ?? "CUSTOMER", a.status ?? "CONFIRMED", a.starts, a.ends,
      a.dur === undefined ? (a.starts && a.ends ? Math.round((Date.parse(a.ends + "Z") - Date.parse(a.starts + "Z")) / 60000) : null) : a.dur,
      a.staff ?? null, a.bb ?? 0, a.ba ?? 0);
  const idOf = (r: unknown) => Number(rows(r)[0]?.id ?? NaN);

  console.log("--- 1. isolation, four sides ---");
  const apA = idOf(await appt(owner, { biz: bizA, starts: "2026-12-01 08:00", ends: "2026-12-01 08:30" }));
  const apB = idOf(await appt(owner, { biz: bizB, starts: "2026-12-01 08:00", ends: "2026-12-01 08:30" }));
  ok("fixtures: one timed appointment per business", apA > 0 && apB > 0);
  const inserts: Record<string, (b: number) => string> = {
    StaffMember: (b) => `INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES (${b}, 'עובד', now())`,
    StaffServiceAssignment: (b) => `INSERT INTO "StaffServiceAssignment" ("businessId", "staffMemberId", "businessServiceId", "updatedAt")
                                    VALUES (${b}, ${b === bizA ? staffA : staffB}, ${b === bizA ? svcA : svcB}, now())`,
    AvailabilityRule: (b) => `INSERT INTO "AvailabilityRule" ("businessId", "weekday", "startMinute", "endMinute", "updatedAt") VALUES (${b}, 0, 540, 1020, now())`,
    AvailabilityException: (b) => `INSERT INTO "AvailabilityException" ("businessId", "dayKey", "kind", "label", "updatedAt") VALUES (${b}, '2026-12-25', 'CLOSED', 'חג', now())`,
    ServiceBookingPolicy: (b) => `INSERT INTO "ServiceBookingPolicy" ("businessId", "businessServiceId", "updatedAt") VALUES (${b}, ${b === bizA ? svcA : svcB}, now())`,
    BookingSettings: (b) => `INSERT INTO "BookingSettings" ("businessId", "updatedAt") VALUES (${b}, now())`,
    BookingRequest: (b) => `INSERT INTO "BookingRequest" ("businessId", "appointmentId", "contactName", "contactPhone", "fingerprint", "expiresAt", "updatedAt")
                            VALUES (${b}, ${b === bizA ? apA : apB}, 'לקוחה', '972501234567', '${hex((++seq % 10).toString())}', now() + interval '1 hour', now())`,
    AppointmentManageToken: (b) => `INSERT INTO "AppointmentManageToken" ("businessId", "appointmentId", "tokenHash", "expiresAt")
                                    VALUES (${b}, ${b === bizA ? apA : apB}, '${hex(b === bizA ? "a" : "b")}', now() + interval '30 days')`,
    AppointmentEvent: (b) => `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "actorUserId", "idempotencyKey")
                              VALUES (${b}, ${b === bizA ? apA : apB}, 'APPOINTMENT_CREATED', 'OWNER_USER', ${b === bizA ? userA : userB}, '${tok("auto-")}')`,
  };
  for (const [table, ins] of Object.entries(inserts)) {
    const noCtx = await x(runtime, null, ins(bizA));
    ok(`${table}: no context → write refused`, refused(noCtx, RLS), String(noCtx));
    const own = await x(runtime, bizA, ins(bizA));
    ok(`${table}: own business → written`, own === 1, String(own));
    await x(runtime, bizB, ins(bizB));
    ok(`${table}: no context → nothing visible`, num(await q(runtime, null, `SELECT count(*)::int AS n FROM "${table}"`)) === 0);
    const seenA = num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "${table}"`));
    const otherA = num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "${table}" WHERE "businessId" <> ${bizA}`));
    ok(`${table}: own rows visible, the other business's invisible`, seenA >= 1 && otherA === 0, `seen ${seenA}, other ${otherA}`);
    const naming = await x(runtime, bizA, ins(bizB));
    ok(`${table}: a write naming the other business refused`, refused(naming, RLS) || refused(naming, FK), String(naming));
    const del = await x(runtime, bizA, `DELETE FROM "${table}" WHERE "businessId" = ${bizA}`);
    ok(`${table}: DELETE refused`, refused(del, DENIED), String(del));
    if (table !== "AppointmentEvent") {
      const touch = table === "AppointmentManageToken" ? `"revokedAt" = "revokedAt"` : `"updatedAt" = now()`;
      const cross = await x(runtime, bizA, `UPDATE "${table}" SET ${touch} WHERE "businessId" = ${bizB}`);
      ok(`${table}: the other business's rows unchangeable`, cross === 0, String(cross));
    }
  }
  const apptNoCtx = num(await q(runtime, null, `SELECT count(*)::int AS n FROM "Appointment"`));
  const apptCross = await x(runtime, bizA, `UPDATE "Appointment" SET "version" = "version" + 1 WHERE "businessId" = ${bizB}`);
  ok("Appointment: no context → nothing visible; the other business's rows unchangeable", apptNoCtx === 0 && apptCross === 0);
  ok("Appointment: DELETE stays unreachable (no DELETE policy)", (await x(runtime, bizA, `DELETE FROM "Appointment" WHERE "id" = ${apA}`)) === 0);

  console.log("--- 2. cross-business references ---");
  ok("appointment → another business's staff member refused",
    refused(await appt(runtime, { biz: bizA, starts: "2026-12-02 08:00", ends: "2026-12-02 09:00", staff: staffB }), FK));
  ok("assignment → another business's service refused",
    refused(await x(runtime, bizA, `INSERT INTO "StaffServiceAssignment" ("businessId", "staffMemberId", "businessServiceId", "updatedAt") VALUES (${bizA}, ${staffA}, ${svcB}, now())`), FK));
  ok("rule → another business's staff member refused",
    refused(await x(runtime, bizA, `INSERT INTO "AvailabilityRule" ("businessId", "staffMemberId", "weekday", "startMinute", "endMinute", "updatedAt") VALUES (${bizA}, ${staffB}, 1, 540, 600, now())`), FK));
  ok("journal → another business's appointment refused",
    refused(await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "idempotencyKey") VALUES (${bizA}, ${apB}, 'APPOINTMENT_CREATED', 'SYSTEM', '${tok("auto-")}')`), FK));
  ok("appointment creator from another business refused",
    refused(await appt(runtime, { biz: bizA, user: userB, starts: "2026-12-02 10:00", ends: "2026-12-02 11:00" }), SAME_BIZ));
  ok("journal actor from another business refused",
    refused(await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "actorUserId", "idempotencyKey") VALUES (${bizA}, ${apA}, 'APPOINTMENT_CREATED', 'OWNER_USER', ${userB}, '${tok("auto-")}')`), SAME_BIZ));

  console.log("--- 3. no overlap ---");
  const day = "2026-12-03";
  const base = idOf(await appt(runtime, { biz: bizA, starts: `${day} 09:00`, ends: `${day} 10:00` }));
  ok("a timed appointment is written", base > 0);
  ok("an overlapping one in the same lane is refused",
    refused(await appt(runtime, { biz: bizA, starts: `${day} 09:30`, ends: `${day} 10:30` }), OVERLAP));
  ok("one starting exactly at the end is allowed",
    idOf(await appt(runtime, { biz: bizA, starts: `${day} 10:00`, ends: `${day} 10:30` })) > 0);
  ok("a buffer before reaches back into the previous one → refused",
    refused(await appt(runtime, { biz: bizA, starts: `${day} 10:30`, ends: `${day} 11:00`, bb: 10 }), OVERLAP));
  ok("PROPOSED occupies the time too",
    refused(await appt(runtime, { biz: bizA, status: "PROPOSED", starts: `${day} 09:15`, ends: `${day} 09:45` }), OVERLAP));
  ok("the same time in another business is allowed",
    idOf(await appt(runtime, { biz: bizB, starts: `${day} 09:00`, ends: `${day} 10:00` })) > 0);
  ok("the same time for a staff member (another lane) is allowed",
    idOf(await appt(runtime, { biz: bizA, starts: `${day} 09:00`, ends: `${day} 10:00`, staff: staffA })) > 0);
  ok("the same staff member twice is refused",
    refused(await appt(runtime, { biz: bizA, starts: `${day} 09:30`, ends: `${day} 09:45`, staff: staffA }), OVERLAP));
  await x(runtime, bizA, `UPDATE "Appointment" SET "status" = 'CANCELED', "cancelReason" = 'OWNER_CANCELED' WHERE "id" = ${base}`);
  ok("a cancelled appointment frees its time",
    idOf(await appt(runtime, { biz: bizA, starts: `${day} 09:00`, ends: `${day} 09:30` })) > 0);
  ok("a block occupies its lane",
    idOf(await appt(runtime, { biz: bizA, kind: "BLOCK", starts: `${day} 13:00`, ends: `${day} 15:00` })) > 0
    && refused(await appt(runtime, { biz: bizA, starts: `${day} 14:00`, ends: `${day} 14:30` }), OVERLAP));
  ok("a block naming a customer is refused (kind shape)",
    refused(await x(runtime, bizA, `INSERT INTO "Appointment" ("businessId", "createdByActor", "sourceChannel", "createdByUserId", "kind", "status", "startsAt", "endsAt", "businessServiceId", "updatedAt")
      VALUES (${bizA}, 'OWNER', 'INBOX_WEB', ${userA}, 'BLOCK', 'CONFIRMED', '${day} 18:00', '${day} 19:00', ${svcA}, now())`), CHECK));
  ok("an end before the start is refused", refused(await appt(runtime, { biz: bizA, starts: `${day} 20:00`, ends: `${day} 19:00`, dur: null }), CHECK));
  ok("a duration that disagrees with the end is refused", refused(await appt(runtime, { biz: bizA, starts: `${day} 20:00`, ends: `${day} 21:00`, dur: 30 }), CHECK));
  // The two existing creation paths write no end time: never covered, even at the very same start.
  const legacy1 = idOf(await appt(runtime, { biz: bizA, status: "PROPOSED", starts: `${day} 14:00`, ends: null, dur: 60 }));
  const legacy2 = idOf(await appt(runtime, { biz: bizA, status: "PROPOSED", starts: `${day} 14:00`, ends: null, dur: 60 }));
  const legacy3 = idOf(await appt(runtime, { biz: bizA, status: "PROPOSED", starts: null, ends: null, dur: null }));
  ok("appointments without an end time are never refused (existing paths)", legacy1 > 0 && legacy2 > 0 && legacy3 > 0);
  ok("…and the existing lifecycle still moves them",
    (await x(runtime, bizA, `UPDATE "Appointment" SET "status" = 'CONFIRMED' WHERE "id" IN (${legacy1}, ${legacy2})`)) === 2);

  console.log("--- 4. concurrency ---");
  const race = await Promise.all(Array.from({ length: 12 }, () =>
    inTx(runtime, bizA, async (tx) => {
      const r = await tx.$queryRawUnsafe(apptSql, bizA, "OWNER", userA, "CUSTOMER", "CONFIRMED", "2026-12-04 09:00", "2026-12-04 10:00", 60, null, 0, 0);
      await tx.$executeRawUnsafe(`SELECT pg_sleep(0.3)`);
      return r;
    })));
  const won = race.filter((r) => typeof r !== "string").length;
  const lost = race.filter((r) => refused(r, OVERLAP)).length;
  ok("twelve concurrent claims of one slot → exactly one succeeds, eleven refused by the constraint", won === 1 && lost === 11, `won ${won}, refused ${lost}`);
  ok("…and the database holds exactly one", num(await q(owner, null,
    `SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizA} AND "startsAt" = '2026-12-04 09:00' AND "endsAt" IS NOT NULL`)) === 1);
  const lanes = await Promise.all(Array.from({ length: 12 }, (_, i) => staff(bizA, `עובד ${i}`)));
  const fan = await Promise.all(lanes.map((s) =>
    inTx(runtime, bizA, (tx) => tx.$queryRawUnsafe(apptSql, bizA, "OWNER", userA, "CUSTOMER", "CONFIRMED", "2026-12-05 09:00", "2026-12-05 10:00", 60, s, 0, 0))));
  ok("twelve concurrent claims of twelve different lanes all succeed", fan.every((r) => typeof r !== "string"));

  console.log("--- 5. decision 6: who acted ---");
  ok("OWNER without a user refused",
    refused(await appt(runtime, { biz: bizA, user: null, starts: "2026-12-06 09:00", ends: "2026-12-06 10:00" }), CHECK));
  ok("CUSTOMER without a user allowed",
    idOf(await appt(runtime, { biz: bizA, actor: "CUSTOMER", user: null, status: "PROPOSED", starts: "2026-12-06 09:00", ends: "2026-12-06 10:00" })) > 0);
  ok("SYSTEM without a user allowed",
    idOf(await appt(runtime, { biz: bizA, actor: "SYSTEM", user: null, starts: "2026-12-06 11:00", ends: "2026-12-06 12:00" })) > 0);
  ok("a CUSTOMER journal event naming a user refused",
    refused(await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "actorUserId", "idempotencyKey") VALUES (${bizA}, ${apA}, 'APPOINTMENT_CREATED', 'CUSTOMER', ${userA}, '${tok("auto-")}')`), CHECK));

  console.log("--- 6. the journal ---");
  ok("runtime UPDATE refused", refused(await x(runtime, bizA, `UPDATE "AppointmentEvent" SET "eventType" = 'APPOINTMENT_CANCELED' WHERE "businessId" = ${bizA}`), DENIED));
  ok("owner UPDATE refused", refused(await x(owner, null, `UPDATE "AppointmentEvent" SET "eventType" = 'APPOINTMENT_CANCELED'`), APPEND_ONLY));
  ok("owner DELETE refused", refused(await x(owner, null, `DELETE FROM "AppointmentEvent"`), APPEND_ONLY));
  ok("owner TRUNCATE refused", refused(await x(owner, null, `TRUNCATE "AppointmentEvent"`), APPEND_ONLY));
  ok("free text in the payload refused",
    refused(await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "idempotencyKey", "payload") VALUES (${bizA}, ${apA}, 'APPOINTMENT_DETAILS_CHANGED', 'SYSTEM', '${tok("auto-")}', '{"note": "the customer said hello"}')`), CHECK));

  console.log("--- 7. account erasure ---");
  ok("without a context: refused", refused(await q(runtime, null, `SELECT public.appointment_erase_business() AS n`), ERASURE));
  ok("an active business: refused", refused(await q(runtime, bizA, `SELECT public.appointment_erase_business() AS n`), ERASURE));
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = ${bizA}`);
  const erased = await q(runtime, bizA, `SELECT public.appointment_erase_business() AS n`);
  ok("a business being deleted: its acting users and digests are nulled", num(erased) >= 1, String(erased));
  ok("…none left for that business", num(await q(owner, null, `SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = ${bizA} AND "actorUserId" IS NOT NULL`)) === 0);
  ok("…the other business untouched", num(await q(owner, null, `SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = ${bizB} AND "actorUserId" IS NOT NULL`)) >= 1);
  ok("the runtime blanks staff names, contacts and appointment text in place (UPDATE, as the adapter does)",
    (await x(runtime, bizA, `UPDATE "StaffMember" SET "displayName" = '', "erasedAt" = now() WHERE "businessId" = ${bizA}`)) >= 1
    && (await x(runtime, bizA, `UPDATE "BookingRequest" SET "contactName" = '', "contactPhone" = NULL, "contactEmail" = NULL, "customerNote" = NULL, "erasedAt" = now() WHERE "businessId" = ${bizA}`)) >= 1
    && (await x(runtime, bizA, `UPDATE "Appointment" SET "title" = NULL, "notes" = NULL, "locationDetail" = NULL, "customerId" = NULL, "leadId" = NULL, "erasedAt" = now() WHERE "businessId" = ${bizA}`)) >= 1);

  console.log("--- 8. flags ---");
  ok("appointments and public_booking are OFF", num(await q(owner, null,
    `SELECT count(*)::int AS n FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('appointments', 'public_booking') AND NOT "globalEnabled"`)) === 2);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
