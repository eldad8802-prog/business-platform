/**
 * G5 M4 + M5 — what migrations 20261109090000 (send permission flag) and 20261109091000 (one-time code + device trust)
 * do, on the Production-shaped lab (.acct/m45-lab.sh), as the real roles:
 *   owner   (lab_owner: the migration role, BYPASSRLS — fixtures only),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS — the tenant plane),
 *   console (app_admin_lab: a LOGIN member of app_admin).
 *
 *   PHASE=before: the two tables do not exist; the three event types are refused; the flag does not exist.
 *   PHASE=after:
 *     1. the flag `accountant_delivery` exists OFF (definition + policy), no business has it;
 *     2. codes: the runtime adds one for its own business's delivery; the CHECKs refuse a code without its salted hash,
 *        a lifetime over 15 minutes, a 6th attempt, a use before issue; it may change only attempts / consumedAt;
 *        no DELETE; isolation (no context, the other business, a delivery of the other business by the composite key);
 *     3. the attempt counter under 8 concurrent increments stops at 5; a code is consumed ONCE under 8 concurrent uses;
 *     4. devices: one per cookie hash (unique), lifetime ≤ 16 days, only lastSeenAt / revokedAt change; isolation;
 *     5. the trail: the three new types accepted (own business), every earlier value kept, unknown refused, payload
 *        closed, append-only;
 *     6. the console reads neither table;
 *     7. every pre-existing accountant table's ACL, RLS, policies, triggers and constraints (the type list aside) are
 *        exactly as before.
 *
 * env: OWNER_URL, RUNTIME_URL, ADMIN_URL, PHASE, SHAPE_BEFORE. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

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
const FK = /foreign key|23503/i;
const UNIQUE = /unique|23505/i;
const NOW = "(now() AT TIME ZONE 'UTC')";
let seq = 0;
const key = (p = "k") => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;
const SHA = (s: string) => createHash("sha256").update(s).digest("hex");
const HEX32 = (s: string) => SHA(s).slice(0, 32);
const pubId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2) + "x".repeat(32)).slice(0, 32);

const TYPES_20261107 = [
  "PERIOD_EVALUATED", "PACKAGE_BUILT", "PACKAGE_BUILD_FAILED", "PACKAGE_SUPERSEDED", "PACKAGE_DOWNLOADED_BY_OWNER",
  "ISSUED_PDFS_PREPARED", "NOTIFIED", "REMINDED", "CHANGED_AFTER_SEND", "RECIPIENT_SET", "RECIPIENT_CHANGED",
  "DELIVERY_APPROVED", "DELIVERY_CANCELED", "DELIVERY_SENDING", "DELIVERY_RETRY_SCHEDULED", "DELIVERY_ACCEPTED",
  "DELIVERY_DELIVERED", "DELIVERY_BOUNCED", "DELIVERY_FAILED", "LINK_DOWNLOADED", "LINK_REFUSED", "LINK_REVOKED",
  "PERIOD_COMPLETED", "PERIOD_COMPLETED_MANUALLY", "LINK_VIEWED", "LINK_FILE_DOWNLOADED", "DELIVERY_COMPLAINED",
];
const NEW_TYPES = ["LINK_CODE_SENT", "LINK_CODE_FAILED", "LINK_DEVICE_VERIFIED"];
const WORKFLOW = ["AccountantPeriod", "AccountantPackage", "AccountantRecipient", "AccountantDelivery", "AccountantWorkflowEvent"];

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

async function main() {
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('m45-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('m45-B', now()) RETURNING "id"`);
  const ev = (client: PrismaClient, guc: number | null, biz: number, type: string, payload = "{}") =>
    x(client, guc, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "eventType", "actor", "occurredAt", "payload", "idempotencyKey")
                    VALUES (${biz}, '${type}', 'RECIPIENT', ${NOW}, '${payload}', '${key("ev")}')`);

  if (PHASE === "before") {
    console.log("before the migrations");
    ok("the two tables do not exist", (await num(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('AccountantLinkChallenge', 'AccountantLinkDevice')`)) === 0);
    let all = true;
    for (const t of NEW_TYPES) if (!refused(await ev(runtime, bizA, bizA, t), CHECK)) all = false;
    ok("the three new event types are refused", all);
    ok("the flag accountant_delivery does not exist", (await num(owner, null, `SELECT count(*)::int AS n FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery'`)) === 0);
    const shape = rows(await q(owner, null, SHAPE));
    console.log(`SHAPE=${Buffer.from(JSON.stringify(shape)).toString("base64")}`);
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exitCode = 1;
    return;
  }
  if (PHASE !== "after") throw new Error("PHASE must be before | after");

  // Fixtures: a delivery in each business (owner; the delivery insert guard applies).
  const user = (b: number) => mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${key("u")}@m45.lab`, b);
  const fixture = async (b: number) => {
    const u = await user(b);
    const p = await mk(`INSERT INTO "AccountantPeriod" ("businessId", "periodKey", "status", "createdAt", "updatedAt") VALUES ($1, '2026-09', 'PREPARING', ${NOW}, ${NOW}) RETURNING "id"`, b);
    const sha = SHA(`pkg-${b}`);
    const k = await mk(`INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "storageKey", "sha256", "sizeBytes", "readyAt", "createdAt")
                        VALUES ($1, $2, 1, $3, 'READY', 'biz/' || $1 || '/exports/accountant/2026-09/v1-abc.zip', $4, 1000, ${NOW}, ${NOW}) RETURNING "id"`, b, p, SHA("f"), sha);
    const d = await mk(`INSERT INTO "AccountantDelivery" ("businessId", "periodId", "packageId", "packageVersion", "packageSha256", "recipientVersion", "recipientName", "recipientEmail",
                          "approvedByUserId", "approvedAt", "incompleteAcknowledged", "openItemCount", "idempotencyKey", "status", "linkPublicId", "linkTokenHash", "linkExpiresAt", "createdAt", "updatedAt")
                        VALUES ($1, $2, $3, 1, $4, 1, 'n', 'cpa@example.com', $5, ${NOW}, false, 0, $6, 'APPROVED', $7, $8, ${NOW} + interval '14 days', ${NOW}, ${NOW}) RETURNING "id"`,
      b, p, k, sha, u, key("idem"), pubId(), SHA(key("t")));
    return d;
  };
  const dA = await fixture(bizA);
  const dB = await fixture(bizB);
  const challenge = (guc: number | null, b: number, d: number, extra: { minutes?: number; attempts?: number; salt?: string; hash?: string } = {}) =>
    q(runtime, guc, `INSERT INTO "AccountantLinkChallenge" ("businessId", "deliveryId", "salt", "codeHash", "createdAt", "expiresAt", "attempts")
                     VALUES (${b}, ${d}, '${extra.salt ?? HEX32(key("s"))}', '${extra.hash ?? SHA(key("c"))}', ${NOW}, ${NOW} + interval '${extra.minutes ?? 10} minutes', ${extra.attempts ?? 0}) RETURNING "id"`);
  const device = (guc: number | null, b: number, d: number, extra: { days?: number; hash?: string } = {}) =>
    q(runtime, guc, `INSERT INTO "AccountantLinkDevice" ("businessId", "deliveryId", "tokenHash", "createdAt", "expiresAt")
                     VALUES (${b}, ${d}, '${extra.hash ?? SHA(key("dev"))}', ${NOW}, ${NOW} + interval '${extra.days ?? 14} days') RETURNING "id"`);

  console.log("1. the send permission flag (M4)");
  const def = rows(await q(owner, null, `SELECT "defaultEnabled", "mutable", "category" FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery'`))[0];
  const pol = rows(await q(owner, null, `SELECT "globalEnabled", "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery'`))[0];
  ok("the flag exists OFF: defaultEnabled false, mutable, documents; policy globalEnabled false, not emergency-disabled",
    def?.defaultEnabled === false && def?.mutable === true && def?.category === "documents" && pol?.globalEnabled === false && pol?.emergencyDisabled === false, JSON.stringify({ def, pol }));
  ok("no business has it", (await num(owner, null, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery'`)) === 0);

  console.log("2. codes (M5)");
  const c1 = rows(await challenge(bizA, bizA, dA))[0];
  ok("the runtime adds a code for its own business's delivery", Number(c1?.id) > 0);
  ok("a code without its salted hash shape is refused", refused(await challenge(bizA, bizA, dA, { hash: "123456" }), CHECK));
  ok("a salt that is not 16 hex bytes is refused", refused(await challenge(bizA, bizA, dA, { salt: "abc" }), CHECK));
  ok("a lifetime over 15 minutes is refused", refused(await challenge(bizA, bizA, dA, { minutes: 20 }), CHECK));
  ok("a 6th attempt is refused", refused(await challenge(bizA, bizA, dA, { attempts: 6 }), CHECK));
  ok("a use before the issue is refused",
    refused(await x(runtime, bizA, `UPDATE "AccountantLinkChallenge" SET "consumedAt" = ${NOW} - interval '1 hour' WHERE "id" = ${c1?.id}`), CHECK));
  ok("the runtime cannot change a code's hash", refused(await x(runtime, bizA, `UPDATE "AccountantLinkChallenge" SET "codeHash" = '${SHA("x")}' WHERE "id" = ${c1?.id}`), DENIED));
  ok("the runtime cannot change a code's expiry", refused(await x(runtime, bizA, `UPDATE "AccountantLinkChallenge" SET "expiresAt" = ${NOW} WHERE "id" = ${c1?.id}`), DENIED));
  ok("the runtime cannot delete a code", refused(await x(runtime, bizA, `DELETE FROM "AccountantLinkChallenge" WHERE "id" = ${c1?.id}`), DENIED));
  ok("no tenant context → refused", refused(await challenge(null, bizA, dA), RLS));
  ok("naming the other business → refused", refused(await challenge(bizA, bizB, dB), RLS));
  ok("business A's code for business B's delivery → refused by the composite key (even for the owner)",
    refused(await q(owner, null, `INSERT INTO "AccountantLinkChallenge" ("businessId", "deliveryId", "salt", "codeHash", "createdAt", "expiresAt")
                                  VALUES (${bizA}, ${dB}, '${HEX32("s")}', '${SHA("c")}', ${NOW}, ${NOW} + interval '10 minutes') RETURNING "id"`), FK));
  ok("business B sees none of A's codes", (await num(runtime, bizB, `SELECT count(*)::int AS n FROM "AccountantLinkChallenge"`)) === 0);
  ok("business B cannot consume A's code", (await x(runtime, bizB, `UPDATE "AccountantLinkChallenge" SET "consumedAt" = ${NOW} WHERE "id" = ${c1?.id}`)) === 0);

  console.log("3. attempts and single use under concurrency");
  const c2 = Number(rows(await challenge(bizA, bizA, dA))[0]?.id);
  const incs = await Promise.all(Array.from({ length: 8 }, () =>
    x(runtime, bizA, `UPDATE "AccountantLinkChallenge" SET "attempts" = "attempts" + 1 WHERE "id" = ${c2} AND "attempts" < 5 AND "consumedAt" IS NULL`)));
  ok("8 concurrent wrong attempts: exactly 5 counted, the code is then locked",
    incs.filter((n) => n === 1).length === 5 && (await num(runtime, bizA, `SELECT "attempts" AS n FROM "AccountantLinkChallenge" WHERE "id" = ${c2}`)) === 5, JSON.stringify(incs));
  const c3 = Number(rows(await challenge(bizA, bizA, dA))[0]?.id);
  const uses = await Promise.all(Array.from({ length: 8 }, () =>
    x(runtime, bizA, `UPDATE "AccountantLinkChallenge" SET "consumedAt" = ${NOW} WHERE "id" = ${c3} AND "consumedAt" IS NULL`)));
  ok("8 concurrent uses of the right code: consumed exactly once", uses.filter((n) => n === 1).length === 1, JSON.stringify(uses));

  console.log("4. devices (M5)");
  const h = SHA(key("cookie"));
  const v1 = rows(await device(bizA, bizA, dA, { hash: h }))[0];
  ok("the runtime records a device for its own business's delivery", Number(v1?.id) > 0);
  ok("the same cookie hash twice is refused (one row per cookie)", refused(await device(bizA, bizA, dA, { hash: h }), UNIQUE));
  ok("a device lifetime over 16 days is refused", refused(await device(bizA, bizA, dA, { days: 17 }), CHECK));
  ok("the runtime marks it seen and revoked",
    (await x(runtime, bizA, `UPDATE "AccountantLinkDevice" SET "lastSeenAt" = ${NOW}, "revokedAt" = ${NOW} WHERE "id" = ${v1?.id}`)) === 1);
  ok("the runtime cannot move a device to another delivery", refused(await x(runtime, bizA, `UPDATE "AccountantLinkDevice" SET "deliveryId" = ${dA} WHERE "id" = ${v1?.id}`), DENIED));
  ok("the runtime cannot extend a device", refused(await x(runtime, bizA, `UPDATE "AccountantLinkDevice" SET "expiresAt" = ${NOW} + interval '15 days' WHERE "id" = ${v1?.id}`), DENIED));
  ok("the runtime cannot delete a device", refused(await x(runtime, bizA, `DELETE FROM "AccountantLinkDevice" WHERE "id" = ${v1?.id}`), DENIED));
  ok("no tenant context → refused", refused(await device(null, bizA, dA), RLS));
  ok("naming the other business → refused", refused(await device(bizA, bizB, dB), RLS));
  ok("business B sees none of A's devices", (await num(runtime, bizB, `SELECT count(*)::int AS n FROM "AccountantLinkDevice"`)) === 0);

  console.log("5. the trail");
  let all = true;
  for (const t of NEW_TYPES) if ((await ev(runtime, bizA, bizA, t, '{"reason":"wrong_code"}')) !== 1) all = false;
  ok("the three new types are accepted (runtime, own business)", all);
  all = true;
  for (const t of TYPES_20261107) if ((await ev(runtime, bizA, bizA, t)) !== 1) all = false;
  ok("every 2026-11-07 type is still accepted", all);
  ok("an unknown type is refused", refused(await ev(runtime, bizA, bizA, "LINK_CODE_GUESSED"), CHECK));
  ok("a code in a payload is refused (closed payload: no text, no spaces)", refused(await ev(runtime, bizA, bizA, "LINK_CODE_SENT", '{"code":"12 34 56"}'), CHECK));
  ok("the OWNER's UPDATE of a new event is refused by the trigger",
    refused(await x(owner, null, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "eventType" = 'LINK_DEVICE_VERIFIED'`), /ACCOUNTANT_EVENT_APPEND_ONLY/));

  console.log("6. the console (app_admin)");
  ok("the console reads no code", refused(await q(admin, null, `SELECT count(*) FROM "AccountantLinkChallenge"`), DENIED));
  ok("the console reads no device", refused(await q(admin, null, `SELECT count(*) FROM "AccountantLinkDevice"`), DENIED));

  console.log("7. nothing else changed");
  const con = rows(await q(owner, null, `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'`))[0];
  ok("the type constraint is validated and exactly the 2026-11-07 list plus the three new values",
    con?.convalidated === true && [...TYPES_20261107, ...NEW_TYPES].every((t) => String(con?.def).includes(`'${t}'::text`)) &&
      (String(con?.def).match(/'[A-Z_]+'::text/g) ?? []).length === TYPES_20261107.length + NEW_TYPES.length, String(con?.def));
  const before = process.env.SHAPE_BEFORE ? JSON.parse(Buffer.from(process.env.SHAPE_BEFORE, "base64").toString()) : null;
  const after = rows(await q(owner, null, SHAPE));
  ok("ACL, RLS, policies, triggers and constraints of the 5 workflow tables are exactly as before",
    before !== null && JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }).slice(0, 400));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); await admin.$disconnect(); });
