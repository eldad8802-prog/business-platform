/**
 * Appointments completion — migration 20261226090000_appointments_completion, AS the real roles (.apc/lab.sh):
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane).
 *
 *   1. Ledger: recorded and finished once; nothing unfinished.
 *   2. Objects: tables, columns, enum labels, indexes, constraints, triggers, the two definer doors.
 *   3. Existing rows (.apc/pre.sql, written BEFORE the migration) keep their values and take the safe defaults:
 *      BookingSettings keeps MANUAL / no verification; a NEW row gets AUTO / verification; an existing appointment
 *      is in no series; an existing push delivery is a USER delivery with no WhatsApp column; the journal is intact.
 *   4. Isolation per new table (and on the new columns of "NotificationDelivery"), as the runtime: no context →
 *      nothing visible, every write refused; the other business's rows invisible and unchangeable; a write naming the
 *      other business refused; DELETE refused.
 *   5. Cross-business references refused by the database (series → staff / service / customer / user; occurrence →
 *      series; delivery → appointment).
 *   6. The CHECKs refuse every malformed row (series rule, settings bounds, challenge shape, delivery privacy shape).
 *   7. The new enum labels are usable once committed (journal ARRIVED … SELF_RESCHEDULED, channel WHATSAPP).
 *   8. The journal is still append-only (UPDATE / DELETE / TRUNCATE refused, owner included).
 *   9. The two doors: SECURITY DEFINER, search_path pinned, EXECUTE for app_runtime only; due rows / exact id only.
 *  10. Erasure shapes: the runtime can clear every new personal column in its own context.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const MIGRATION = "20261226090000_appointments_completion";
const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=30`;
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
const UNIQUE = /unique constraint|23505/i;
const SAME_BIZ = /APPOINTMENT_USER_OTHER_BUSINESS|DZA03/;
const APPEND_ONLY = /APPOINTMENT_EVENT_APPEND_ONLY|DZA01/;

let seq = 0;
const tok = (p = "k") => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;
const hex = (c: string) => c.repeat(64).slice(0, 64);

async function main() {
  // ── 1. Ledger ──────────────────────────────────────────────────────────────────────────────────
  console.log("1. ledger");
  ok("1.1 the migration is recorded and finished, once",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIGRATION)) === 1);
  ok("1.2 no migration is unfinished or rolled back",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);

  // ── 2. Objects ─────────────────────────────────────────────────────────────────────────────────
  console.log("2. objects");
  const cols = async (table: string, names: string[]) => num(await q(owner, null,
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`, table, names));
  ok("2.1 AppointmentSeries: 21 columns", num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'AppointmentSeries'`)) === 21);
  ok("2.2 BookingPhoneChallenge: 12 columns", num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingPhoneChallenge'`)) === 12);
  ok("2.3 Appointment: seriesId, seriesIndex", (await cols("Appointment", ["seriesId", "seriesIndex"])) === 2);
  ok("2.4 BookingSettings: the five new columns, NOT NULL with defaults",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND column_name IN ('selfRescheduleEnabled','selfRescheduleWindowHours','reminderOffsetsMinutes','bookingHorizonDays','showLogo') AND is_nullable = 'NO' AND column_default IS NOT NULL`)) === 5);
  ok("2.5 BookingRequest: phoneVerifiedAt", (await cols("BookingRequest", ["phoneVerifiedAt"])) === 1);
  ok("2.6 NotificationDelivery: the eight new columns",
    (await cols("NotificationDelivery", ["recipientKind", "recipientPhone", "templateKey", "messageClass", "providerMessageId", "providerStatus", "providerUpdatedAt", "appointmentId"])) === 8);
  const labels = async (t: string) => rows(await q(owner, null,
    `SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`, t)).map((r) => String(r.l));
  ok("2.7 AppointmentEventType: the 7 old labels, then the 7 new ones in order",
    (await labels("AppointmentEventType")).join() === "APPOINTMENT_CREATED,APPOINTMENT_CONFIRMED,APPOINTMENT_COMPLETED,APPOINTMENT_NO_SHOW,APPOINTMENT_CANCELED,APPOINTMENT_RESCHEDULED,APPOINTMENT_DETAILS_CHANGED,ARRIVED,STATUS_CORRECTED,CUSTOMER_CHANGED,SERVICE_CHANGED,SERIES_CREATED,SERIES_CHANGED,SELF_RESCHEDULED");
  ok("2.8 NotificationChannel = IN_APP, PUSH, WHATSAPP", (await labels("NotificationChannel")).join() === "IN_APP,PUSH,WHATSAPP");
  ok("2.9 AppointmentSeriesFrequency = WEEKLY, BIWEEKLY", (await labels("AppointmentSeriesFrequency")).join() === "WEEKLY,BIWEEKLY");
  const idx = ["AppointmentSeries_id_businessId_key", "AppointmentSeries_businessId_cancelledAt_idx", "Appointment_businessId_seriesId_seriesIndex_key",
    "BookingPhoneChallenge_businessId_phoneHash_createdAt_idx", "BookingPhoneChallenge_businessId_ipHash_createdAt_idx",
    "NotificationDelivery_whatsapp_owed_idx", "NotificationDelivery_providerMessageId_key", "NotificationDelivery_businessId_appointmentId_idx",
    "NotificationDelivery_customer_sent_idx"];
  ok("2.10 the nine indexes exist", num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'i' AND relname = ANY($1::text[])`, idx)) === 9);
  ok("2.11 providerMessageId's index is UNIQUE and partial",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'NotificationDelivery_providerMessageId_key' AND i.indisunique AND i.indpred IS NOT NULL`)) === 1);
  const cons = ["AppointmentSeries_rule", "AppointmentSeries_end", "AppointmentSeries_kind_shape", "AppointmentSeries_title_length", "AppointmentSeries_version_positive",
    "AppointmentSeries_staffMemberId_tenant_fkey", "AppointmentSeries_businessServiceId_tenant_fkey", "AppointmentSeries_customerId_tenant_fkey",
    "AppointmentSeries_createdByUserId_fkey", "AppointmentSeries_businessId_fkey", "Appointment_series_shape", "Appointment_seriesId_tenant_fkey",
    "BookingSettings_self_reschedule_window", "BookingSettings_reminder_offsets", "BookingSettings_horizon",
    "BookingPhoneChallenge_hashes", "BookingPhoneChallenge_counters", "BookingPhoneChallenge_lifetime", "BookingPhoneChallenge_consumed_after_verified",
    "BookingPhoneChallenge_businessId_fkey", "NotificationDelivery_recipient_kind", "NotificationDelivery_customer_channel",
    "NotificationDelivery_recipient_phone", "NotificationDelivery_whatsapp_shape", "NotificationDelivery_whatsapp_tokens",
    "NotificationDelivery_provider_status_shape", "NotificationDelivery_appointmentId_tenant_fkey"];
  ok(`2.12 the ${cons.length} constraints exist and are validated`,
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY($1::text[]) AND convalidated`, cons)) === cons.length);
  ok("2.13 the same-business trigger guards AppointmentSeries.createdByUserId",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'AppointmentSeries_user_same_business' AND NOT tgisinternal`)) === 1);
  ok("2.14 both new tables: RLS enabled AND forced",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('AppointmentSeries','BookingPhoneChallenge') AND relrowsecurity AND relforcerowsecurity`)) === 2);
  ok("2.15 six policies (SELECT / INSERT / UPDATE each), no DELETE and no ALL policy",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('AppointmentSeries','BookingPhoneChallenge')`)) === 6
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('AppointmentSeries','BookingPhoneChallenge') AND cmd IN ('DELETE','ALL')`)) === 0);
  ok("2.16 runtime privileges: SELECT, INSERT, UPDATE — no DELETE, TRUNCATE, REFERENCES, TRIGGER",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM unnest(ARRAY['AppointmentSeries','BookingPhoneChallenge']) t
      WHERE has_table_privilege('app_runtime', format('%I', t), 'SELECT,INSERT,UPDATE') AND NOT has_table_privilege('app_runtime', format('%I', t), 'DELETE')
        AND NOT has_table_privilege('app_runtime', format('%I', t), 'TRUNCATE') AND NOT has_table_privilege('app_runtime', format('%I', t), 'REFERENCES')
        AND NOT has_table_privilege('app_runtime', format('%I', t), 'TRIGGER')`)) === 2);
  ok("2.17 PUBLIC and app_auth hold nothing on the new tables",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name IN ('AppointmentSeries','BookingPhoneChallenge') AND grantee IN ('PUBLIC','app_auth')`)) === 0);

  // ── 3. Existing rows ───────────────────────────────────────────────────────────────────────────
  console.log("3. existing rows");
  const bizPre = num(await q(owner, null, `SELECT id AS n FROM "Business" WHERE name = 'apc-pre-A'`));
  ok("3.0 the pre-migration fixture exists (.apc/pre.sql)", Number.isInteger(bizPre) && bizPre > 0);
  const st = rows(await q(owner, null, `SELECT "defaultApprovalMode"::text AS a, "requireVerification" AS v, "selfRescheduleEnabled" AS sr, "selfRescheduleWindowHours" AS srw,
      "reminderOffsetsMinutes"::text AS ro, "bookingHorizonDays" AS h, "showLogo" AS logo, enabled, version FROM "BookingSettings" WHERE "businessId" = $1`, bizPre))[0];
  ok("3.1 existing settings keep MANUAL and no verification (the old defaults they were written with)", !!st && st.a === "MANUAL" && st.v === false, JSON.stringify(st));
  ok("3.2 …take the new defaults: self-reschedule off / 24 h, reminders {1440}, horizon 60, logo hidden; still disabled, version 1",
    !!st && st.sr === false && Number(st.srw) === 24 && st.ro === "{1440}" && Number(st.h) === 60 && st.logo === false && st.enabled === false && Number(st.version) === 1, JSON.stringify(st));
  const bizNew = num(await q(owner, null, `INSERT INTO "Business" (name, "updatedAt") VALUES ('apc-new', now()) RETURNING id AS n`));
  await x(runtime, bizNew, `INSERT INTO "BookingSettings" ("businessId", "updatedAt") VALUES ($1, now())`, bizNew);
  const st2 = rows(await q(owner, null, `SELECT "defaultApprovalMode"::text AS a, "requireVerification" AS v, enabled FROM "BookingSettings" WHERE "businessId" = $1`, bizNew))[0];
  ok("3.3 a NEW settings row (written by the runtime) gets AUTO and verification on — and stays disabled", !!st2 && st2.a === "AUTO" && st2.v === true && st2.enabled === false, JSON.stringify(st2));
  ok("3.4 the existing appointment is in no series",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = $1 AND "seriesId" IS NULL AND "seriesIndex" IS NULL`, bizPre)) === 1);
  const dl = rows(await q(owner, null, `SELECT "recipientKind" AS k, "recipientPhone" AS p, "templateKey" AS t, "messageClass" AS c, "providerMessageId" AS m, "appointmentId" AS a, channel::text AS ch, status::text AS s
      FROM "NotificationDelivery" WHERE "businessId" = $1`, bizPre))[0];
  ok("3.5 the existing push delivery: a USER delivery, every new column NULL, channel and status unchanged",
    !!dl && dl.k === "USER" && dl.p === null && dl.t === null && dl.c === null && dl.m === null && dl.a === null && dl.ch === "PUSH" && dl.s === "PENDING", JSON.stringify(dl));
  ok("3.6 the existing journal event is intact",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "AppointmentEvent" WHERE "businessId" = $1 AND "eventType" = 'APPOINTMENT_CREATED' AND "idempotencyKey" = 'apc-pre-event-0001'`, bizPre)) === 1);
  ok("3.7 every pre-existing settings row everywhere is still MANUAL / no verification",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "BookingSettings" WHERE "businessId" <> $1 AND ("defaultApprovalMode" <> 'MANUAL' OR "requireVerification")`, bizNew)) === 0);

  // ── Fixtures (owner) ───────────────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('apc-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('apc-B', now()) RETURNING "id"`);
  const user = (b: number, tag: string) =>
    mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${tok()}@apc.lab`, b);
  const userA = await user(bizA, "a");
  const userB = await user(bizB, "b");
  const svc = (b: number) => mk(`INSERT INTO "BusinessService" ("businessId", "name", "type", "updatedAt") VALUES ($1, 'תספורת', 'SERVICE', now()) RETURNING "id"`, b);
  const svcA = await svc(bizA); const svcB = await svc(bizB);
  const staff = (b: number) => mk(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'דנה', now()) RETURNING "id"`, b);
  const staffA = await staff(bizA); const staffB = await staff(bizB);
  const cust = (b: number) => mk(`INSERT INTO "Customer" ("businessId", "name", "phone", "updatedAt") VALUES ($1, 'לקוח', $2, now()) RETURNING "id"`, b, `0500${String(++seq).padStart(6, "0")}`);
  const custA = await cust(bizA); const custB = await cust(bizB);
  let hour = 0;
  const appt = (b: number) => mk(`INSERT INTO "Appointment" ("businessId", status, "startsAt", "endsAt", "durationMinutes", "createdByActor", "sourceChannel", "updatedAt")
    VALUES ($1, 'CONFIRMED', now() + ($2 || ' hours')::interval, now() + ($2 || ' hours')::interval + interval '30 minutes', 30, 'SYSTEM', 'PUBLIC_BOOKING', now()) RETURNING "id"`, b, String(100 + hour++));
  const apptA = await appt(bizA); const apptB = await appt(bizB);
  const notif = (b: number) => mk(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
      "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, $2, 'appointments', 'appointments.lab', 'info', 'appointment', 1, 'x', '/calendar', ARRAY['IN_APP']::"NotificationChannel"[], 'lab', 24, now()) RETURNING "id"`, b, tok("n"));
  const notifA = await notif(bizA); const notifB = await notif(bizB);

  const seriesSql = `INSERT INTO "AppointmentSeries" ("businessId", "frequency", "interval", "weekday", "startMinute", "durationMinutes", "staffMemberId",
      "businessServiceId", "customerId", "kind", "title", "startsOn", "endsOn", "occurrenceCount", "createdByUserId", "updatedAt")
    VALUES ($1, $2::text::"AppointmentSeriesFrequency", $3, $4, $5, $6, $7, $8, $9, $10::text::"AppointmentKind", $11, $12::date, $13::date, $14, $15, now()) RETURNING id AS n`;
  type S = { b: number; freq?: string; interval?: number; weekday?: number; start?: number; dur?: number; staff?: number | null; svc?: number | null;
    cust?: number | null; kind?: string; title?: string | null; from?: string; until?: string | null; count?: number | null; user?: number | null };
  const series = (client: PrismaClient, guc: number | null, s: S) => q(client, guc, seriesSql, s.b, s.freq ?? "WEEKLY", s.interval ?? 1, s.weekday ?? 2,
    s.start ?? 600, s.dur ?? 30, s.staff ?? null, s.svc ?? null, s.cust ?? null, s.kind ?? "CUSTOMER", s.title ?? null, s.from ?? "2026-12-01",
    s.until ?? null, s.count ?? null, s.user ?? null);

  const chSql = `INSERT INTO "BookingPhoneChallenge" ("businessId", "phoneHash", "codeHash", "ipHash", "attempts", "sends", "expiresAt", "verifiedAt", "consumedAt")
    VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval, $8::timestamp, $9::timestamp) RETURNING id AS n`;
  type C = { b: number; phone?: string | null; code?: string | null; ip?: string | null; attempts?: number; sends?: number; minutes?: number; verified?: string | null; consumed?: string | null };
  const challenge = (client: PrismaClient, guc: number | null, c: C) => q(client, guc, chSql, c.b, c.phone === undefined ? hex("a") : c.phone,
    c.code === undefined ? hex("c") : c.code, c.ip ?? null, c.attempts ?? 0, c.sends ?? 1, String(c.minutes ?? 10), c.verified ?? null, c.consumed ?? null);

  const dSql = `INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "recipientKind", "recipientPhone", "templateKey",
      "messageClass", "providerMessageId", "providerStatus", "providerUpdatedAt", "appointmentId", "nextAttemptAt", "userId")
    VALUES ($1, $2, $3::text::"NotificationChannel", $4::text::"NotificationDeliveryStatus", $5, $6, $7, $8, $9, $10, $11::timestamp, $12, $13::timestamp, $14) RETURNING id AS n`;
  type D = { b: number; n: number; ch?: string; st?: string; kind?: string; phone?: string | null; tpl?: string | null; cls?: string | null;
    pmid?: string | null; pst?: string | null; pat?: string | null; appt?: number | null; next?: string | null; user?: number | null };
  const delivery = (client: PrismaClient, guc: number | null, d: D) => q(client, guc, dSql, d.b, d.n, d.ch ?? "WHATSAPP", d.st ?? "PENDING", d.kind ?? "CUSTOMER",
    d.phone === undefined ? "+972501234567" : d.phone, d.tpl === undefined ? "appointment_reminder" : d.tpl, d.cls === undefined ? "OPERATIONAL" : d.cls,
    d.pmid ?? null, d.pst ?? null, d.pat ?? null, d.appt ?? null, d.next ?? null, d.user ?? null);

  // ── 4. Isolation ───────────────────────────────────────────────────────────────────────────────
  console.log("4. isolation");
  const sA = num(await series(runtime, bizA, { b: bizA, staff: staffA, svc: svcA, cust: custA, title: "שבועי", user: userA, count: 10 }));
  const sB = num(await series(owner, null, { b: bizB, staff: staffB, svc: svcB, cust: custB, user: userB }));
  ok("4.1 the runtime creates a full series in its own context", Number.isInteger(sA) && sA > 0);
  const cA = num(await challenge(runtime, bizA, { b: bizA, ip: hex("e") }));
  const cB = num(await challenge(owner, null, { b: bizB }));
  ok("4.2 the runtime creates a challenge in its own context", Number.isInteger(cA) && cA > 0);
  for (const [t, idA, idB] of [["AppointmentSeries", sA, sB], ["BookingPhoneChallenge", cA, cB]] as const) {
    ok(`4.3 ${t}: no context → nothing visible`, num(await q(runtime, null, `SELECT count(*)::int AS n FROM "${t}"`)) === 0);
    ok(`4.4 ${t}: A sees its own row and not B's`, rows(await q(runtime, bizA, `SELECT id FROM "${t}" WHERE id IN ($1, $2)`, idA, idB)).map((r) => Number(r.id)).join() === String(idA));
    ok(`4.5 ${t}: A cannot change B's row (0 rows)`, (await x(runtime, bizA, `UPDATE "${t}" SET "createdAt" = "createdAt" WHERE id = $1`, idB)) === 0);
    ok(`4.6 ${t}: A cannot move its row to B`, refused(await x(runtime, bizA, `UPDATE "${t}" SET "businessId" = $2 WHERE id = $1`, idA, bizB), RLS));
    ok(`4.7 ${t}: DELETE refused even for its own row`, refused(await x(runtime, bizA, `DELETE FROM "${t}" WHERE id = $1`, idA), DENIED));
  }
  ok("4.8 AppointmentSeries: A cannot write a row of B", refused(await series(runtime, bizA, { b: bizB }), RLS));
  ok("4.9 AppointmentSeries: no context → every write refused", refused(await series(runtime, null, { b: bizA }), RLS));
  ok("4.10 BookingPhoneChallenge: A cannot write a row of B", refused(await challenge(runtime, bizA, { b: bizB }), RLS));
  ok("4.11 BookingPhoneChallenge: no context → every write refused", refused(await challenge(runtime, null, { b: bizA }), RLS));
  const dA = num(await delivery(runtime, bizA, { b: bizA, n: notifA, appt: apptA }));
  const dB = num(await delivery(owner, null, { b: bizB, n: notifB, appt: apptB, pmid: "sim:b-0001" }));
  ok("4.12 the runtime writes a customer WhatsApp delivery in its own context", Number.isInteger(dA) && dA > 0);
  ok("4.13 NotificationDelivery: A sees none of B's customer rows (phone included)",
    num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE id = $1 OR "recipientPhone" IS NOT NULL AND "businessId" <> $2`, dB, bizA)) === 0);
  ok("4.14 NotificationDelivery: A cannot stamp B's provider status", (await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "providerStatus" = 'read', "providerUpdatedAt" = now() WHERE id = $1`, dB)) === 0);

  // ── 5. Cross-business references ────────────────────────────────────────────────────────────────
  console.log("5. cross-business references");
  ok("5.1 a series of A naming B's staff member is refused", refused(await series(runtime, bizA, { b: bizA, staff: staffB }), FK));
  ok("5.2 …B's service", refused(await series(runtime, bizA, { b: bizA, svc: svcB }), FK));
  ok("5.3 …B's customer", refused(await series(runtime, bizA, { b: bizA, cust: custB }), FK));
  ok("5.4 …B's user (same-business trigger)", refused(await series(runtime, bizA, { b: bizA, user: userB }), SAME_BIZ));
  ok("5.5 an appointment of A placed in B's series is refused",
    refused(await x(runtime, bizA, `UPDATE "Appointment" SET "seriesId" = $1, "seriesIndex" = 0 WHERE id = $2`, sB, apptA), FK));
  ok("5.6 a delivery of A about B's appointment is refused", refused(await delivery(runtime, bizA, { b: bizA, n: notifA, appt: apptB }), FK));
  ok("5.7 an appointment of A joins A's series (index 0)", (await x(runtime, bizA, `UPDATE "Appointment" SET "seriesId" = $1, "seriesIndex" = 0 WHERE id = $2`, sA, apptA)) === 1);
  const apptA2 = await appt(bizA);
  ok("5.8 a second occurrence with the same (series, index) is refused",
    refused(await x(runtime, bizA, `UPDATE "Appointment" SET "seriesId" = $1, "seriesIndex" = 0 WHERE id = $2`, sA, apptA2), UNIQUE));
  ok("5.9 the runtime finds the occurrences of a series by (businessId, seriesId)",
    num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = $1 AND "seriesId" = $2`, bizA, sA)) === 1);

  // ── 6. CHECKs ──────────────────────────────────────────────────────────────────────────────────
  console.log("6. checks");
  const badSeries: [string, S][] = [
    ["weekday 7", { b: bizA, weekday: 7 }], ["start minute 1440", { b: bizA, start: 1440 }], ["duration 4", { b: bizA, dur: 4 }],
    ["duration 1441", { b: bizA, dur: 1441 }], ["WEEKLY interval 5", { b: bizA, interval: 5 }], ["WEEKLY interval 0", { b: bizA, interval: 0 }],
    ["BIWEEKLY interval 2", { b: bizA, freq: "BIWEEKLY", interval: 2 }], ["end before start", { b: bizA, until: "2026-11-01" }],
    ["end date AND count", { b: bizA, until: "2027-01-01", count: 5 }], ["count 0", { b: bizA, count: 0 }], ["count 521", { b: bizA, count: 521 }],
    ["a BLOCK naming a customer", { b: bizA, kind: "BLOCK", cust: custA }], ["an INTERNAL naming a service", { b: bizA, kind: "INTERNAL", svc: svcA }],
    ["a 201-character title", { b: bizA, title: "א".repeat(201) }],
  ];
  for (const [name, s] of badSeries) ok(`6.1 series refused: ${name}`, refused(await series(runtime, bizA, s), CHECK));
  ok("6.2 series accepted: BIWEEKLY, an end date, a BLOCK without customer",
    Number.isInteger(num(await series(runtime, bizA, { b: bizA, freq: "BIWEEKLY", until: "2027-06-01" })))
    && Number.isInteger(num(await series(runtime, bizA, { b: bizA, kind: "BLOCK" }))));
  ok("6.3 an appointment with a series and no index is refused", refused(await x(runtime, bizA, `UPDATE "Appointment" SET "seriesId" = $1, "seriesIndex" = NULL WHERE id = $2`, sA, apptA2), CHECK));
  ok("6.4 an index without a series is refused", refused(await x(runtime, bizA, `UPDATE "Appointment" SET "seriesIndex" = 3 WHERE id = $1`, apptA2), CHECK));
  ok("6.5 a negative index is refused", refused(await x(runtime, bizA, `UPDATE "Appointment" SET "seriesId" = $1, "seriesIndex" = -1 WHERE id = $2`, sA, apptA2), CHECK));
  const set = (sql: string) => x(runtime, bizNew, `UPDATE "BookingSettings" SET ${sql} WHERE "businessId" = $1`, bizNew);
  for (const [name, sql] of [["four reminders", `"reminderOffsetsMinutes" = '{60,120,180,240}'`], ["a 29-minute reminder", `"reminderOffsetsMinutes" = '{29}'`],
    ["a reminder over 7 days", `"reminderOffsetsMinutes" = '{10081}'`], ["a NULL reminder", `"reminderOffsetsMinutes" = '{60,NULL}'`],
    ["a 2-D list", `"reminderOffsetsMinutes" = '{{60},{120}}'`], ["horizon 0", `"bookingHorizonDays" = 0`], ["horizon 366", `"bookingHorizonDays" = 366`],
    ["self-reschedule window 721", `"selfRescheduleWindowHours" = 721`], ["self-reschedule window −1", `"selfRescheduleWindowHours" = -1`]] as const) {
    ok(`6.6 settings refused: ${name}`, refused(await set(sql), CHECK));
  }
  ok("6.7 settings accepted: three reminders 30 / 1440 / 10080, no reminder at all, horizon 1 and 365",
    (await set(`"reminderOffsetsMinutes" = '{30,1440,10080}', "bookingHorizonDays" = 365`)) === 1
    && (await set(`"reminderOffsetsMinutes" = '{}', "bookingHorizonDays" = 1`)) === 1);
  const badCh: [string, C][] = [
    ["7 attempts", { b: bizA, attempts: 6 }], ["negative attempts", { b: bizA, attempts: -1 }], ["0 sends", { b: bizA, sends: 0 }], ["11 sends", { b: bizA, sends: 11 }],
    ["a phone in clear instead of a hash", { b: bizA, phone: "972501234567" }], ["no code hash", { b: bizA, code: null }], ["a malformed IP hash", { b: bizA, ip: "1.2.3.4" }],
    ["a 61-minute lifetime", { b: bizA, minutes: 61 }], ["already expired", { b: bizA, minutes: -1 }],
    ["consumed without verification", { b: bizA, consumed: "2026-12-01 10:00" }],
  ];
  for (const [name, c] of badCh) ok(`6.8 challenge refused: ${name}`, refused(await challenge(runtime, bizA, c), CHECK));
  const badD: [string, D][] = [
    ["a USER delivery with a phone", { b: bizA, n: notifA, ch: "PUSH", kind: "USER", tpl: null, cls: null }],
    ["a CUSTOMER delivery on PUSH", { b: bizA, n: notifA, ch: "PUSH" }],
    ["a USER delivery on WHATSAPP", { b: bizA, n: notifA, kind: "USER", phone: null, tpl: null, cls: null }],
    ["an unknown recipient kind", { b: bizA, n: notifA, kind: "LEAD" }],
    ["a phone without +", { b: bizA, n: notifA, phone: "972501234567" }], ["a phone with letters", { b: bizA, n: notifA, phone: "+97250abc4567" }],
    ["a customer message without a template", { b: bizA, n: notifA, tpl: null }], ["a customer message without a class", { b: bizA, n: notifA, cls: null }],
    ["an unknown class", { b: bizA, n: notifA, cls: "MARKETING" }], ["a template key with spaces", { b: bizA, n: notifA, tpl: "Appointment Reminder" }],
    ["a provider status without a provider id", { b: bizA, n: notifA, pst: "sent", pat: "2026-12-01 10:00" }],
    ["a provider status without its time", { b: bizA, n: notifA, pmid: "sim:x-1", pst: "sent" }],
    ["an unknown provider status", { b: bizA, n: notifA, pmid: "sim:x-2", pst: "seen", pat: "2026-12-01 10:00" }],
    ["a customer delivery naming a user", { b: bizA, n: notifA, user: userA }],
    ["a USER delivery with a template", { b: bizA, n: notifA, ch: "PUSH", kind: "USER", phone: null, cls: null }],
  ];
  for (const [name, d] of badD) ok(`6.9 delivery refused: ${name}`, refused(await delivery(runtime, bizA, d), CHECK));
  ok("6.10 a second delivery with the same provider id is refused (unique, across businesses)",
    refused(await delivery(owner, null, { b: bizA, n: notifA, pmid: "sim:b-0001" }), UNIQUE));
  ok("6.11 a plain push delivery is still accepted as before (USER by default)",
    num(await q(runtime, bizA, `INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status") VALUES ($1, $2, 'PUSH', 'PENDING') RETURNING ("recipientKind" = 'USER')::int AS n`, bizA, notifA)) === 1);

  // ── 7. New labels usable ───────────────────────────────────────────────────────────────────────
  console.log("7. new enum labels");
  let k = 0;
  for (const t of ["ARRIVED", "STATUS_CORRECTED", "CUSTOMER_CHANGED", "SERVICE_CHANGED", "SERIES_CREATED", "SERIES_CHANGED", "SELF_RESCHEDULED"]) {
    if ((await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "actorUserId", "payload", "idempotencyKey")
        VALUES ($1, $2, $3::text::"AppointmentEventType", 'OWNER_USER', $4, '{"from":"CONFIRMED","to":"COMPLETED","seriesId":1}', $5)`, bizA, apptA, t, userA, tok(`apc:${t}:`))) === 1) k++;
  }
  ok("7.1 the runtime journals each of the 7 new event types", k === 7, `${k}`);
  ok("7.2 the payload stays closed for the new types (free text refused)",
    refused(await x(runtime, bizA, `INSERT INTO "AppointmentEvent" ("businessId", "appointmentId", "eventType", "actor", "payload", "idempotencyKey")
      VALUES ($1, $2, 'ARRIVED', 'SYSTEM', '{"note":"הלקוח הגיע עם חבר"}', $3)`, bizA, apptA, tok("apc:free:")), CHECK));
  ok("7.3 WHATSAPP is a usable channel (4.12 wrote one)", num(await q(owner, null, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE channel = 'WHATSAPP'`)) >= 2);

  // ── 8. The journal is still append-only ────────────────────────────────────────────────────────
  console.log("8. append-only journal");
  ok("8.1 the runtime has no UPDATE on the journal", refused(await x(runtime, bizA, `UPDATE "AppointmentEvent" SET "occurredAt" = now() WHERE "businessId" = $1`, bizA), DENIED));
  ok("8.2 the owner's UPDATE is refused by the trigger", refused(await x(owner, null, `UPDATE "AppointmentEvent" SET "occurredAt" = now() WHERE "businessId" = $1`, bizA), APPEND_ONLY));
  ok("8.3 the owner's DELETE is refused by the trigger", refused(await x(owner, null, `DELETE FROM "AppointmentEvent" WHERE "businessId" = $1`, bizA), APPEND_ONLY));
  ok("8.4 TRUNCATE is refused", refused(await x(owner, null, `TRUNCATE "AppointmentEvent"`), APPEND_ONLY));

  // ── 9. The two doors ───────────────────────────────────────────────────────────────────────────
  console.log("9. doors");
  const fns = rows(await q(owner, null, `SELECT p.proname AS name, p.prosecdef AS def, array_to_string(p.proconfig, ',') AS cfg,
      has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt, has_function_privilege('app_auth', p.oid, 'EXECUTE') AS au,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS pub
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('notification_whatsapp_due','notification_delivery_by_provider_message')`));
  ok("9.1 both exist, SECURITY DEFINER, search_path pinned", fns.length === 2 && fns.every((f) => f.def === true && f.cfg === "search_path=pg_catalog, public, pg_temp"), JSON.stringify(fns));
  ok("9.2 EXECUTE for app_runtime, not PUBLIC, not app_auth", fns.every((f) => f.rt === true && f.pub === false && f.au === false));
  const leased = num(await delivery(owner, null, { b: bizA, n: notifA }));
  await x(owner, null, `UPDATE "NotificationDelivery" SET "leaseUntil" = now() + interval '5 minutes' WHERE id = $1`, leased);
  const later = num(await delivery(owner, null, { b: bizA, n: notifA, next: "2099-01-01 00:00" }));
  const sent = num(await delivery(owner, null, { b: bizA, n: notifA, st: "SENT", pmid: "wamid.HBgMOTcyNTAxMjM0NTY3FQIAERgSQ0Q=" }));
  const due = rows(await q(runtime, null, `SELECT "businessId" AS b, "deliveryId" AS d FROM public.notification_whatsapp_due(now()::timestamp(3), 500)`)).map((r) => Number(r.d));
  ok("9.3 due: the owed customer rows (A's and B's)", due.includes(dA) && due.includes(dB), JSON.stringify(due));
  ok("9.4 …not a leased one, not a future one, not a sent one, not a push row", !due.includes(leased) && !due.includes(later) && !due.includes(sent)
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE id = ANY($1::int[]) AND channel <> 'WHATSAPP'`, due)) === 0);
  ok("9.5 due: identifiers only; the limit holds", Object.keys(rows(await q(runtime, null, `SELECT * FROM public.notification_whatsapp_due(now()::timestamp(3), 1)`))[0] ?? {}).sort().join() === "businessId,deliveryId"
    && rows(await q(runtime, null, `SELECT * FROM public.notification_whatsapp_due(now()::timestamp(3), 1)`)).length === 1);
  const byId = (id: string) => q(runtime, null, `SELECT "businessId" AS b, "deliveryId" AS d FROM public.notification_delivery_by_provider_message($1)`, id);
  ok("9.6 by provider id: exact id → its business and delivery", rows(await byId("wamid.HBgMOTcyNTAxMjM0NTY3FQIAERgSQ0Q=")).map((r) => `${r.b}:${r.d}`).join() === `${bizA}:${sent}`);
  ok("9.7 an unknown, a prefix, a wildcard or a malformed id → nothing",
    rows(await byId("wamid.nope")).length === 0 && rows(await byId("wamid.HBgM")).length === 0 && rows(await byId("%")).length === 0 && rows(await byId("' OR 1=1 --")).length === 0);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, bizB);
  ok("9.8 a business being deleted: its rows are neither due nor resolvable",
    !rows(await q(runtime, null, `SELECT "deliveryId" AS d FROM public.notification_whatsapp_due(now()::timestamp(3), 500)`)).some((r) => Number(r.d) === dB)
    && rows(await byId("sim:b-0001")).length === 0);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = NULL WHERE id = $1`, bizB);
  ok("9.9 the runtime records the provider's status in its own context",
    (await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "providerStatus" = 'delivered', "providerUpdatedAt" = now() WHERE id = $1`, sent)) === 1);
  ok("9.10 metering: customer messages handed to the provider, counted per business",
    num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "businessId" = $1 AND "recipientKind" = 'CUSTOMER' AND "providerMessageId" IS NOT NULL`, bizA)) === 1);

  // ── 10. Erasure shapes ─────────────────────────────────────────────────────────────────────────
  console.log("10. erasure shapes");
  ok("10.1 a series' title and customer are cleared in place", (await x(runtime, bizA, `UPDATE "AppointmentSeries" SET "title" = NULL, "customerId" = NULL, "erasedAt" = now() WHERE "businessId" = $1`, bizA)) >= 1);
  ok("10.2 a challenge's three hashes are cleared in place", (await x(runtime, bizA, `UPDATE "BookingPhoneChallenge" SET "phoneHash" = NULL, "codeHash" = NULL, "ipHash" = NULL, "erasedAt" = now() WHERE "businessId" = $1`, bizA)) === 1);
  ok("10.3 …but never half-way (hashes cleared without erasedAt refused)",
    refused(await x(owner, null, `UPDATE "BookingPhoneChallenge" SET "phoneHash" = NULL WHERE id = $1`, cB), CHECK));
  ok("10.4 a customer delivery's phone is cleared in place",
    (await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "recipientPhone" = NULL WHERE "businessId" = $1 AND "recipientPhone" IS NOT NULL`, bizA)) >= 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "businessId" = $1 AND "recipientPhone" IS NOT NULL`, bizA)) === 0);
  ok("10.5 B's rows are untouched by A's erasure",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE id = $1 AND "recipientPhone" IS NOT NULL`, dB)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "BookingPhoneChallenge" WHERE id = $1 AND "phoneHash" IS NOT NULL`, cB)) === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
