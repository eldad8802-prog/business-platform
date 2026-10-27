/**
 * Accountant package operations monitoring (G5 milestone 1) — what migrations 20261107090000 / 091000 / 092000 do,
 * on the Production-shaped lab (.acct/ops-lab.sh), as the real roles:
 *   owner   (lab_owner: the migration role, BYPASSRLS),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS — the tenant plane),
 *   console (app_admin_lab: a LOGIN member of app_admin, the admin console's read role).
 *
 *   PHASE=before (not applied yet):
 *     1. DELIVERY_COMPLAINED is refused; the three tables do not exist; the console reads no accountant table.
 *   PHASE=after (applied):
 *     2. runs: the runtime records a run and finishes it; text in the counts, an unfinished run with an end, an
 *        end before the start, a change of the start, DELETE and TRUNCATE are refused;
 *     3. platform alerts: one open alert per finding — a repeat and 8 concurrent openings leave ONE row; 8
 *        concurrent claims of its notification succeed ONCE; an address / a link in the detail is refused; a
 *        resolved finding that comes back is a new row; DELETE refused;
 *     4. business alerts: tenant isolation (no context, the other business, naming the other business), one open
 *        alert per business and finding (concurrently too), the same finding in two businesses is two alerts;
 *        DELETE refused;
 *     5. the trail: DELIVERY_COMPLAINED accepted as the runtime for its own business; every 2026-11-05 value
 *        still accepted; an unknown one refused; the payload stays closed; append-only; isolation;
 *     6. the console: reads the three monitoring tables across businesses; writes nothing; still reads NO
 *        accountant workflow table (period, package, recipient, delivery, trail) and no business data beyond;
 *     7. nothing else changed: every pre-existing accountant table's ACL, RLS, policies, triggers and
 *        constraints (the type list aside) are exactly as before.
 *
 * env: OWNER_URL, RUNTIME_URL, ADMIN_URL, PHASE, SHAPE_BEFORE. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const admin = new PrismaClient({ datasourceUrl: process.env.ADMIN_URL! });
const PHASE = process.env.PHASE;

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
  }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string) => inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string) => inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = async (client: PrismaClient, guc: number | null, sql: string) => Number(rows(await q(client, guc, sql))[0]?.n);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const CHECK = /check constraint|23514/i;
const RLS = /row-level security/i;
const DENIED = /permission denied/i;
const NOW = "(now() AT TIME ZONE 'UTC')";
let seq = 0;
const key = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;

const TYPES_20261105 = [
  "PERIOD_EVALUATED", "PACKAGE_BUILT", "PACKAGE_BUILD_FAILED", "PACKAGE_SUPERSEDED", "PACKAGE_DOWNLOADED_BY_OWNER",
  "ISSUED_PDFS_PREPARED", "NOTIFIED", "REMINDED", "CHANGED_AFTER_SEND", "RECIPIENT_SET", "RECIPIENT_CHANGED",
  "DELIVERY_APPROVED", "DELIVERY_CANCELED", "DELIVERY_SENDING", "DELIVERY_RETRY_SCHEDULED", "DELIVERY_ACCEPTED",
  "DELIVERY_DELIVERED", "DELIVERY_BOUNCED", "DELIVERY_FAILED", "LINK_DOWNLOADED", "LINK_REFUSED", "LINK_REVOKED",
  "PERIOD_COMPLETED", "PERIOD_COMPLETED_MANUALLY", "LINK_VIEWED", "LINK_FILE_DOWNLOADED",
];
const WORKFLOW = ["AccountantPeriod", "AccountantPackage", "AccountantRecipient", "AccountantDelivery", "AccountantWorkflowEvent"];

// Every pre-existing accountant table apart from the trail's type list: ACL, RLS flags, policies, triggers, constraints.
const SHAPE = `
  SELECT c.relname,
         c.relrowsecurity::text || c.relforcerowsecurity::text AS rls,
         coalesce(array_to_string(c.relacl, ','), '') AS acl,
         (SELECT string_agg(policyname || ':' || cmd::text || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY policyname)
            FROM pg_policies WHERE tablename = c.relname) AS policies,
         (SELECT string_agg(tgname || ':' || tgenabled::text, '|' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) AS triggers,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint
           WHERE conrelid = c.oid AND conname <> 'AccountantWorkflowEvent_type') AS constraints
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN (${WORKFLOW.map((t) => `'${t}'`).join(", ")})
   ORDER BY c.relname`;

const ALERT_COLS = `"code", "subjectKey", "severity", "detail", "openedAt", "lastSeenAt"`;
const openPlatform = (client: PrismaClient, code: string, subject = "-", detail = "{}") =>
  x(client, null, `INSERT INTO "AccountantOpsAlert" (${ALERT_COLS}) VALUES ('${code}', '${subject}', 'HIGH', '${detail}', ${NOW}, ${NOW})
                   ON CONFLICT ("code", "subjectKey") WHERE "resolvedAt" IS NULL DO NOTHING`);
const openBusiness = (client: PrismaClient, guc: number | null, biz: number, code: string, subject: string, detail = "{}") =>
  x(client, guc, `INSERT INTO "AccountantBusinessAlert" ("businessId", ${ALERT_COLS}) VALUES (${biz}, '${code}', '${subject}', 'CRITICAL', '${detail}', ${NOW}, ${NOW})
                  ON CONFLICT ("businessId", "code", "subjectKey") WHERE "resolvedAt" IS NULL DO NOTHING`);

async function main() {
  const mk = async (sql: string) => Number(rows(await owner.$queryRawUnsafe(sql))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('ops-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('ops-B', now()) RETURNING "id"`);
  const ev = (client: PrismaClient, guc: number | null, biz: number, type: string, payload = "{}") =>
    x(client, guc, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "eventType", "actor", "occurredAt", "payload", "idempotencyKey")
                    VALUES (${biz}, '${type}', 'PROVIDER', ${NOW}, '${payload}', '${key("ev")}')`);

  if (PHASE === "before") {
    console.log("1. before the migrations");
    ok("DELIVERY_COMPLAINED is refused before the migration", refused(await ev(runtime, bizA, bizA, "DELIVERY_COMPLAINED"), CHECK));
    let all = true;
    for (const t of TYPES_20261105) if ((await ev(runtime, bizA, bizA, t)) !== 1) all = false;
    ok("every 2026-11-05 type is accepted", all);
    ok("the three monitoring tables do not exist",
      (await num(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('AccountantOpsRun', 'AccountantOpsAlert', 'AccountantBusinessAlert')`)) === 0);
    let none = true;
    for (const t of WORKFLOW) if (!refused(await q(admin, null, `SELECT count(*) FROM "${t}"`), DENIED)) none = false;
    ok("the console reads no accountant workflow table", none);
    const shape = rows(await q(owner, null, SHAPE));
    console.log(`SHAPE=${Buffer.from(JSON.stringify(shape)).toString("base64")}`);
  } else if (PHASE === "after") {
    console.log("2. runs");
    const run = rows(await q(runtime, null, `INSERT INTO "AccountantOpsRun" ("kind", "source", "startedAt", "outcome")
                                              VALUES ('SWEEP', 'VERCEL_CRON', ${NOW}, 'RUNNING') RETURNING "id"`))[0];
    ok("the runtime records a run (no tenant context needed: a platform table)", Number(run?.id) > 0);
    ok("the runtime finishes it with counts",
      (await x(runtime, null, `UPDATE "AccountantOpsRun" SET "finishedAt" = ${NOW}, "outcome" = 'OK', "counts" = '{"eligible":2,"built":1,"budgetExhausted":false,"byStatus":{"SENT":1}}' WHERE "id" = ${run?.id}`)) === 1);
    ok("text in the counts is refused",
      refused(await x(runtime, null, `UPDATE "AccountantOpsRun" SET "counts" = '{"to":"a@b.co"}' WHERE "id" = ${run?.id}`), CHECK));
    ok("an array in the counts is refused",
      refused(await x(runtime, null, `UPDATE "AccountantOpsRun" SET "counts" = '{"ids":[1,2]}' WHERE "id" = ${run?.id}`), CHECK));
    ok("a RUNNING run with an end is refused",
      refused(await x(runtime, null, `INSERT INTO "AccountantOpsRun" ("kind", "source", "startedAt", "finishedAt", "outcome") VALUES ('MONITOR', 'GITHUB_ACTIONS', ${NOW}, ${NOW}, 'RUNNING')`), CHECK));
    ok("an end before the start is refused",
      refused(await x(runtime, null, `INSERT INTO "AccountantOpsRun" ("kind", "source", "startedAt", "finishedAt", "outcome") VALUES ('MONITOR', 'GITHUB_ACTIONS', ${NOW}, ${NOW} - interval '1 hour', 'OK')`), CHECK));
    ok("an unknown kind is refused",
      refused(await x(runtime, null, `INSERT INTO "AccountantOpsRun" ("kind", "source", "startedAt", "outcome") VALUES ('BACKUP', 'GITHUB_ACTIONS', ${NOW}, 'RUNNING')`), CHECK));
    ok("the runtime cannot change a run's start", refused(await x(runtime, null, `UPDATE "AccountantOpsRun" SET "startedAt" = ${NOW} WHERE "id" = ${run?.id}`), DENIED));
    ok("the runtime cannot delete a run", refused(await x(runtime, null, `DELETE FROM "AccountantOpsRun" WHERE "id" = ${run?.id}`), DENIED));
    ok("the runtime cannot truncate the runs", refused(await x(runtime, null, `TRUNCATE "AccountantOpsRun"`), DENIED));

    console.log("3. platform alerts");
    ok("an alert opens", (await openPlatform(runtime, "SWEEP_MISSED")) === 1);
    ok("the same finding again opens nothing", (await openPlatform(runtime, "SWEEP_MISSED")) === 0);
    await Promise.all(Array.from({ length: 8 }, () => openPlatform(runtime, "SWEEP_FAILED")));
    ok("8 concurrent openings of one finding leave ONE open alert",
      (await num(runtime, null, `SELECT count(*)::int AS n FROM "AccountantOpsAlert" WHERE "code" = 'SWEEP_FAILED' AND "resolvedAt" IS NULL`)) === 1);
    const alertId = Number(rows(await q(runtime, null, `SELECT "id" FROM "AccountantOpsAlert" WHERE "code" = 'SWEEP_FAILED'`))[0]?.id);
    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      x(runtime, null, `UPDATE "AccountantOpsAlert" SET "notifyCount" = "notifyCount" + 1, "lastNotifiedAt" = ${NOW} WHERE "id" = ${alertId} AND "notifyCount" = 0`)));
    ok("8 concurrent claims of its first notification: exactly one wins",
      claims.filter((c) => c === 1).length === 1 && claims.every((c) => c === 0 || c === 1), JSON.stringify(claims));
    ok("an address in the detail is refused", refused(await openPlatform(runtime, "MONITOR_INCOMPLETE", "-", '{"to":"acc@example.co.il"}'), CHECK));
    ok("a link in the detail is refused", refused(await openPlatform(runtime, "MONITOR_INCOMPLETE", "-", '{"u":"https://x.example/a"}'), CHECK));
    ok("a lower-case code is refused", refused(await openPlatform(runtime, "sweep_missed"), CHECK));
    ok("a free-text subject is refused", refused(await openPlatform(runtime, "SWEEP_MISSED", "the sweep"), CHECK));
    ok("notified without a time is refused",
      refused(await x(runtime, null, `UPDATE "AccountantOpsAlert" SET "notifyCount" = 1, "lastNotifiedAt" = NULL WHERE "code" = 'SWEEP_MISSED'`), CHECK));
    ok("the alert resolves", (await x(runtime, null, `UPDATE "AccountantOpsAlert" SET "resolvedAt" = ${NOW} WHERE "code" = 'SWEEP_MISSED' AND "resolvedAt" IS NULL`)) === 1);
    ok("the finding coming back is a new open alert", (await openPlatform(runtime, "SWEEP_MISSED")) === 1);
    ok("…and the resolved one stays as it was",
      (await num(runtime, null, `SELECT count(*)::int AS n FROM "AccountantOpsAlert" WHERE "code" = 'SWEEP_MISSED' AND "resolvedAt" IS NOT NULL`)) === 1);
    ok("the runtime cannot change an alert's code", refused(await x(runtime, null, `UPDATE "AccountantOpsAlert" SET "code" = 'OTHER_CODE' WHERE "id" = ${alertId}`), DENIED));
    ok("the runtime cannot delete an alert", refused(await x(runtime, null, `DELETE FROM "AccountantOpsAlert" WHERE "id" = ${alertId}`), DENIED));

    console.log("4. business alerts");
    ok("business A opens an alert in its own context", (await openBusiness(runtime, bizA, bizA, "PREPARATION_FAILED", "p:2026-09")) === 1);
    ok("no tenant context → refused", refused(await openBusiness(runtime, null, bizA, "SEND_STUCK", "d:1"), RLS));
    ok("naming the other business → refused", refused(await openBusiness(runtime, bizA, bizB, "SEND_STUCK", "d:1"), RLS));
    ok("business B does not see A's alert",
      (await num(runtime, bizB, `SELECT count(*)::int AS n FROM "AccountantBusinessAlert"`)) === 0);
    ok("no context sees nothing", (await num(runtime, null, `SELECT count(*)::int AS n FROM "AccountantBusinessAlert"`)) === 0);
    ok("business B cannot resolve A's alert",
      (await x(runtime, bizB, `UPDATE "AccountantBusinessAlert" SET "resolvedAt" = ${NOW} WHERE "businessId" = ${bizA}`)) === 0);
    await Promise.all(Array.from({ length: 8 }, () => openBusiness(runtime, bizA, bizA, "SEND_UNCERTAIN", "d:7")));
    ok("8 concurrent openings in one business leave ONE open alert",
      (await num(runtime, bizA, `SELECT count(*)::int AS n FROM "AccountantBusinessAlert" WHERE "code" = 'SEND_UNCERTAIN' AND "resolvedAt" IS NULL`)) === 1);
    ok("the same finding in business B is its own alert", (await openBusiness(runtime, bizB, bizB, "PREPARATION_FAILED", "p:2026-09")) === 1);
    ok("an address in a business alert's detail is refused",
      refused(await openBusiness(runtime, bizA, bizA, "DELIVERY_BOUNCED", "d:8", '{"to":"acc@example.co.il"}'), CHECK));
    ok("the runtime cannot delete a business alert",
      refused(await x(runtime, bizA, `DELETE FROM "AccountantBusinessAlert" WHERE "businessId" = ${bizA}`), DENIED));
    ok("the runtime cannot move an alert to another business",
      refused(await x(runtime, bizA, `UPDATE "AccountantBusinessAlert" SET "businessId" = ${bizB} WHERE "businessId" = ${bizA}`), DENIED));

    console.log("5. the trail");
    ok("DELIVERY_COMPLAINED is accepted (runtime, own business)", (await ev(runtime, bizA, bizA, "DELIVERY_COMPLAINED", '{"provider":"resend"}')) === 1);
    let all = true;
    for (const t of TYPES_20261105) if ((await ev(runtime, bizA, bizA, t)) !== 1) all = false;
    ok("every 2026-11-05 type is still accepted", all);
    ok("an unknown type is still refused", refused(await ev(runtime, bizA, bizA, "DELIVERY_READ"), CHECK));
    ok("free text in a complaint's payload is refused", refused(await ev(runtime, bizA, bizA, "DELIVERY_COMPLAINED", '{"to":"acc@example.co.il"}'), CHECK));
    ok("the OWNER's UPDATE of a complaint is refused by the trigger",
      refused(await x(owner, null, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "eventType" = 'DELIVERY_COMPLAINED'`), /ACCOUNTANT_EVENT_APPEND_ONLY/));
    ok("a complaint naming the other business → refused", refused(await ev(runtime, bizA, bizB, "DELIVERY_COMPLAINED"), RLS));

    console.log("6. the console (app_admin)");
    ok("the console reads the runs", (await num(admin, null, `SELECT count(*)::int AS n FROM "AccountantOpsRun"`)) >= 1);
    ok("the console reads the platform alerts", (await num(admin, null, `SELECT count(*)::int AS n FROM "AccountantOpsAlert"`)) >= 3);
    ok("the console reads business alerts of BOTH businesses, with no tenant context",
      (await num(admin, null, `SELECT count(DISTINCT "businessId")::int AS n FROM "AccountantBusinessAlert" WHERE "businessId" IN (${bizA}, ${bizB})`)) === 2);
    ok("the console cannot add a run",
      refused(await x(admin, null, `INSERT INTO "AccountantOpsRun" ("kind", "source", "startedAt", "outcome") VALUES ('SWEEP', 'GITHUB_ACTIONS', ${NOW}, 'RUNNING')`), DENIED));
    ok("the console cannot resolve an alert", refused(await x(admin, null, `UPDATE "AccountantOpsAlert" SET "resolvedAt" = ${NOW}`), DENIED));
    ok("the console cannot delete a business alert", refused(await x(admin, null, `DELETE FROM "AccountantBusinessAlert"`), DENIED));
    let none = true;
    for (const t of WORKFLOW) if (!refused(await q(admin, null, `SELECT count(*) FROM "${t}"`), DENIED)) none = false;
    ok("the console still reads NO accountant workflow table (period, package, recipient, delivery, trail)", none);

    console.log("7. nothing else changed");
    const con = rows(await q(owner, null, `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'`))[0];
    ok("the type constraint keeps its name, is validated, and is exactly the 2026-11-05 list plus DELIVERY_COMPLAINED",
      con?.convalidated === true &&
        [...TYPES_20261105, "DELIVERY_COMPLAINED"].every((t) => String(con?.def).includes(`'${t}'::text`)) &&
        (String(con?.def).match(/'[A-Z_]+'::text/g) ?? []).length === TYPES_20261105.length + 1, String(con?.def));
    const before = process.env.SHAPE_BEFORE ? JSON.parse(Buffer.from(process.env.SHAPE_BEFORE, "base64").toString()) : null;
    const after = rows(await q(owner, null, SHAPE));
    ok("ACL, RLS, policies, triggers and constraints of the 5 workflow tables are exactly as before",
      before !== null && JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }).slice(0, 400));
  } else {
    throw new Error("PHASE must be before | after");
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); await admin.$disconnect(); });
