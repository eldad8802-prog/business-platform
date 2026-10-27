/**
 * Accountant portal (R2) — what migration 20261105090000_accountant_link_events does, on the Production-shaped
 * lab (.acct/lab.sh --with-acct: the accountant workflow applied by `prisma migrate deploy`), as the real roles:
 *   owner   (lab_owner: the migration role, BYPASSRLS),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS — the tenant plane).
 *
 *   PHASE=before (the migration not applied yet):
 *     1. LINK_VIEWED / LINK_FILE_DOWNLOADED are refused by the CHECK; every 2026-10-27 value is accepted.
 *   PHASE=after (applied):
 *     2. both new values are accepted, as the runtime, for its own business;
 *     3. every 2026-10-27 value is still accepted; an unknown value is still refused;
 *     4. the payload stays closed (free text refused) and the trail stays append-only (runtime AND owner);
 *     5. isolation unchanged: no context → refused; naming the other business → refused; the other business's
 *        new events are invisible;
 *     6. the constraint keeps its name and is VALIDATED; nothing else about the table changed (the ACL, RLS
 *        flags, policies and triggers are exactly the 2026-10-27 ones).
 *
 * env: OWNER_URL, RUNTIME_URL, PHASE. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
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
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const CHECK = /check constraint|23514/i;
const RLS = /row-level security/i;
const DENIED = /permission denied/i;
const NOW = "now() AT TIME ZONE 'UTC'";
let seq = 0;
const key = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;

const OLD_TYPES = [
  "PERIOD_EVALUATED", "PACKAGE_BUILT", "PACKAGE_BUILD_FAILED", "PACKAGE_SUPERSEDED", "PACKAGE_DOWNLOADED_BY_OWNER",
  "ISSUED_PDFS_PREPARED", "NOTIFIED", "REMINDED", "CHANGED_AFTER_SEND", "RECIPIENT_SET", "RECIPIENT_CHANGED",
  "DELIVERY_APPROVED", "DELIVERY_CANCELED", "DELIVERY_SENDING", "DELIVERY_RETRY_SCHEDULED", "DELIVERY_ACCEPTED",
  "DELIVERY_DELIVERED", "DELIVERY_BOUNCED", "DELIVERY_FAILED", "LINK_DOWNLOADED", "LINK_REFUSED", "LINK_REVOKED",
  "PERIOD_COMPLETED", "PERIOD_COMPLETED_MANUALLY",
];
const NEW_TYPES = ["LINK_VIEWED", "LINK_FILE_DOWNLOADED"];

// The table's shape apart from the type list: ACL, RLS flags, policies, triggers, other constraints.
const SHAPE = `
  SELECT
    (SELECT relrowsecurity::text || relforcerowsecurity::text FROM pg_class WHERE relname = 'AccountantWorkflowEvent') AS rls,
    (SELECT coalesce(array_to_string(relacl, ','), '') FROM pg_class WHERE relname = 'AccountantWorkflowEvent') AS acl,
    (SELECT string_agg(policyname || ':' || cmd::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY policyname)
       FROM pg_policies WHERE tablename = 'AccountantWorkflowEvent') AS policies,
    (SELECT string_agg(tgname || ':' || tgenabled::text, '|' ORDER BY tgname) FROM pg_trigger
      WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal) AS triggers,
    (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint
      WHERE conrelid = '"AccountantWorkflowEvent"'::regclass AND conname <> 'AccountantWorkflowEvent_type') AS others`;

async function main() {
  const mk = async (sql: string) => Number(rows(await owner.$queryRawUnsafe(sql))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('link-ev-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('link-ev-B', now()) RETURNING "id"`);
  const ins = (client: PrismaClient, guc: number | null, biz: number, type: string, payload = "{}") =>
    x(client, guc, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "eventType", "actor", "occurredAt", "payload", "idempotencyKey")
                    VALUES (${biz}, '${type}', 'RECIPIENT', ${NOW}, '${payload}', '${key("ev")}')`);

  if (PHASE === "before") {
    console.log("1. before the migration");
    for (const t of NEW_TYPES) ok(`${t} is refused before the migration`, refused(await ins(runtime, bizA, bizA, t), CHECK));
    let all = true;
    for (const t of OLD_TYPES) if ((await ins(runtime, bizA, bizA, t)) !== 1) all = false;
    ok("every 2026-10-27 type is accepted", all);
    const shape = rows(await q(owner, null, SHAPE))[0];
    console.log(`SHAPE=${Buffer.from(JSON.stringify(shape)).toString("base64")}`);
  } else if (PHASE === "after") {
    console.log("2. the new types");
    ok("LINK_VIEWED is accepted (runtime, own business)", (await ins(runtime, bizA, bizA, "LINK_VIEWED", '{"packageVersion":1,"files":5}')) === 1);
    ok("LINK_FILE_DOWNLOADED is accepted (runtime, own business)",
      (await ins(runtime, bizA, bizA, "LINK_FILE_DOWNLOADED", '{"kind":"source","mode":"download","documentId":12,"sha16":"0123456789abcdef"}')) === 1);

    console.log("3. the old types and an unknown one");
    let all = true;
    for (const t of OLD_TYPES) if ((await ins(runtime, bizA, bizA, t)) !== 1) all = false;
    ok("every 2026-10-27 type is still accepted", all);
    ok("an unknown type is still refused", refused(await ins(runtime, bizA, bizA, "LINK_EDITED"), CHECK));
    ok("the empty string is refused", refused(await ins(runtime, bizA, bizA, ""), CHECK));

    console.log("4. closed payload, append-only");
    ok("free text in a new event's payload is refused", refused(await ins(runtime, bizA, bizA, "LINK_FILE_DOWNLOADED", '{"path":"approved/doc 1.pdf"}'), CHECK));
    ok("runtime UPDATE of the trail is denied",
      refused(await x(runtime, bizA, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "businessId" = ${bizA} AND "eventType" = 'LINK_VIEWED'`), DENIED));
    ok("the OWNER's UPDATE of a new event is refused by the trigger",
      refused(await x(owner, null, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "businessId" = ${bizA} AND "eventType" = 'LINK_VIEWED'`), /ACCOUNTANT_EVENT_APPEND_ONLY/));
    ok("the OWNER's DELETE of a new event is refused by the trigger",
      refused(await x(owner, null, `DELETE FROM "AccountantWorkflowEvent" WHERE "businessId" = ${bizA} AND "eventType" = 'LINK_FILE_DOWNLOADED'`), /ACCOUNTANT_EVENT_APPEND_ONLY/));

    console.log("5. isolation");
    ok("no tenant context → a new event is refused", refused(await ins(runtime, null, bizA, "LINK_VIEWED"), RLS));
    ok("naming the other business → refused", refused(await ins(runtime, bizA, bizB, "LINK_VIEWED"), RLS));
    await ins(owner, null, bizB, "LINK_VIEWED");
    const seen = rows(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "AccountantWorkflowEvent" WHERE "businessId" = ${bizB}`))[0];
    ok("the other business's new events are invisible", Number(seen?.n) === 0, JSON.stringify(seen));

    console.log("6. the table is otherwise unchanged");
    const con = rows(await q(owner, null, `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'`))[0];
    ok("the constraint keeps its name and is validated", con?.convalidated === true);
    ok("its list is exactly the 2026-10-27 list plus the two new values",
      [...OLD_TYPES, ...NEW_TYPES].every((t) => String(con?.def).includes(`'${t}'::text`)) &&
        (String(con?.def).match(/'[A-Z_]+'::text/g) ?? []).length === OLD_TYPES.length + NEW_TYPES.length, String(con?.def));
    const before = process.env.SHAPE_BEFORE ? JSON.parse(Buffer.from(process.env.SHAPE_BEFORE, "base64").toString()) : null;
    const after = rows(await q(owner, null, SHAPE))[0];
    ok("ACL, RLS, policies, triggers and every other constraint are exactly as before",
      before !== null && JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }).slice(0, 400));
  } else {
    throw new Error("PHASE must be before | after");
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
