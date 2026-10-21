/**
 * Monthly accountant workflow — what migration 20261023090000_accountant_month_close does, measured with the
 * real role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane).
 *
 *   1. Catalog: FORCE RLS on all five tables; per-command policies on the tenant GUC only; the exact ACL of
 *      every table and sequence; PUBLIC holds nothing; EXECUTE on every new function = app_runtime on the
 *      three entry points, nobody on trigger functions; the flag is OFF.
 *   2. Isolation, four sides, per table, as the runtime: no context → nothing visible and every write refused;
 *      own rows visible; the other business's rows invisible and unchangeable; a write naming the other
 *      business refused; DELETE refused everywhere except the recipient (own business only).
 *   3. Cross-business references refused by the database (package → period, delivery → package, users).
 *   4. A package: the storage key is pinned to the business's own prefix; one BUILDING per period; READY needs
 *      an object; a READY package never changes except READY → SUPERSEDED; FAILED / SUPERSEDED are final.
 *   5. A delivery: born APPROVED, only for the current READY package by exact version + sha256; D2 open items
 *      need the acknowledgement; one in flight per period; the link lives ≤ 15 days; approval columns are
 *      frozen; the recipient snapshot can only be erased; a revoked link stays revoked; statuses only move
 *      forward; SENDING needs an address.
 *   6. The trail is append-only (runtime and owner alike); its payload / the readiness / the manifest refuse
 *      free text.
 *   7. Bootstrap lookups return ids only and only on an exact match; account erasure refuses unless the
 *      business is being deleted, and then nulls the trail's acting users only.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

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
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const UNIQUE = /unique constraint|23505/i;

const TABLES = ["AccountantPeriod", "AccountantPackage", "AccountantRecipient", "AccountantDelivery", "AccountantWorkflowEvent"];
const SHA = (c: string) => c.repeat(64).slice(0, 64);
const NOW = "now() AT TIME ZONE 'UTC'";
let seq = 0;
const key = (p = "k") => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;
const pubId = () => key("p").padEnd(32, "x").slice(0, 32);

async function main() {
  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('acct-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('acct-B', now()) RETURNING "id"`);
  const user = (b: number, tag: string) =>
    mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${key()}@acct.lab`, b);
  const userA = await user(bizA, "a");
  const userB = await user(bizB, "b");
  const period = (b: number, k: string) =>
    mk(`INSERT INTO "AccountantPeriod" ("businessId", "periodKey", "status", "createdAt", "updatedAt") VALUES ($1, $2, 'PREPARING', ${NOW}, ${NOW}) RETURNING "id"`, b, k);
  const pkgSql = (b: number, p: number, v: number, sha: string) =>
    mk(`INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "storageKey", "sha256", "sizeBytes", "readyAt", "createdAt")
        VALUES ($1, $2, $3, $4, 'READY', 'biz/' || $1 || '/exports/accountant/2026-09/v' || $3 || '-abc.zip', $5, 1000, ${NOW}, ${NOW}) RETURNING "id"`, b, p, v, SHA("f"), sha);
  const periodA = await period(bizA, "2026-09");
  const periodB = await period(bizB, "2026-09");
  const pkgA = await pkgSql(bizA, periodA, 1, SHA("a"));
  const pkgB = await pkgSql(bizB, periodB, 1, SHA("b"));
  await owner.$executeRawUnsafe(`INSERT INTO "AccountantRecipient" ("businessId", "name", "email", "createdAt", "updatedAt") VALUES ($1, 'רו"ח א', 'cpa-a@example.com', ${NOW}, ${NOW})`, bizA);
  await owner.$executeRawUnsafe(`INSERT INTO "AccountantRecipient" ("businessId", "name", "email", "createdAt", "updatedAt") VALUES ($1, 'רו"ח ב', 'cpa-b@example.com', ${NOW}, ${NOW})`, bizB);
  const delivery = (b: number, p: number, k: number, sha: string, u: number, extra: Record<string, string> = {}) => {
    const cols = { openItemCount: "0", incompleteAcknowledged: "false", ...extra };
    return mk(
      `INSERT INTO "AccountantDelivery" ("businessId", "periodId", "packageId", "packageVersion", "packageSha256", "recipientVersion", "recipientName", "recipientEmail",
         "approvedByUserId", "approvedAt", "incompleteAcknowledged", "openItemCount", "idempotencyKey", "status", "linkPublicId", "linkTokenHash", "linkExpiresAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 1, $4, 1, 'n', 'cpa@example.com', $5, ${NOW}, ${cols.incompleteAcknowledged}, ${cols.openItemCount}, $6, 'APPROVED', $7, $8,
               ${NOW} + interval '14 days', ${NOW}, ${NOW}) RETURNING "id"`,
      b, p, k, sha, u, key("idem"), pubId(), SHA(String(seq % 10)).replace(/^./, String(seq % 10)));
  };
  const deliveryB = await delivery(bizB, periodB, pkgB, SHA("b"), userB);
  await owner.$executeRawUnsafe(`INSERT INTO "AccountantWorkflowEvent" ("businessId", "periodId", "eventType", "actor", "actorUserId", "occurredAt", "idempotencyKey") VALUES ($1, $2, 'PERIOD_EVALUATED', 'OWNER_USER', $3, ${NOW}, $4)`, bizB, periodB, userB, key("ev"));

  // ── 1. Catalog ─────────────────────────────────────────────────────────────────────────────────
  console.log("1. catalog");
  const acl = async (rel: string) => String(rows(await owner.$queryRawUnsafe(
    `SELECT coalesce((SELECT string_agg(pg_get_userbyid(x.grantee) || '=' || x.privilege_type, ',' ORDER BY pg_get_userbyid(x.grantee) || '=' || x.privilege_type)
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid = $1::regclass AND x.grantee <> c.relowner), '') AS a`, rel))[0].a);
  const expectAcl: Record<string, string> = {
    '"AccountantPeriod"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"AccountantPeriod_id_seq"': "app_runtime=SELECT,app_runtime=USAGE",
    '"AccountantPackage"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"AccountantPackage_id_seq"': "app_runtime=SELECT,app_runtime=USAGE",
    '"AccountantRecipient"': "app_runtime=DELETE,app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"AccountantDelivery"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"AccountantDelivery_id_seq"': "app_runtime=SELECT,app_runtime=USAGE",
    '"AccountantWorkflowEvent"': "app_runtime=INSERT,app_runtime=SELECT",
    '"AccountantWorkflowEvent_id_seq"': "app_runtime=SELECT,app_runtime=USAGE",
  };
  for (const [rel, want] of Object.entries(expectAcl)) {
    const got = await acl(rel);
    ok(`ACL ${rel} is exactly {${want}}`, got === want, got);
  }
  for (const t of TABLES) {
    const r = rows(await owner.$queryRawUnsafe(
      `SELECT c.relrowsecurity AS e, c.relforcerowsecurity AS f,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = '*') AS all_cmd,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = 'd') AS del,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polroles <> ARRAY[0]::oid[]) AS role_scoped,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid
                 AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) NOT LIKE '%app.current_business_id%') AS off_guc
         FROM pg_class c WHERE c.oid = $1::regclass`, `"${t}"`))[0];
    const wantDel = t === "AccountantRecipient" ? 1 : 0;
    ok(`${t}: RLS enabled + forced, no FOR ALL, ${wantDel} DELETE policy, every policy on the tenant GUC`,
      r.e === true && r.f === true && Number(r.all_cmd) === 0 && Number(r.del) === wantDel && Number(r.role_scoped) === 0 && Number(r.off_guc) === 0, J(r));
  }
  const fns = rows(await owner.$queryRawUnsafe(
    `SELECT p.proname AS f, p.prosecdef AS definer, pg_get_function_result(p.oid) AS ret,
            coalesce((SELECT string_agg(pg_get_userbyid(x.grantee), ',' ORDER BY pg_get_userbyid(x.grantee))
                        FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner AND x.privilege_type = 'EXECUTE'), '') AS g,
            p.proacl IS NULL AS default_acl
       FROM pg_proc p WHERE p.proname LIKE 'accountant\\_%' ORDER BY 1`));
  const want: Record<string, string> = {
    accountant_link_resolve: "app_runtime",
    accountant_delivery_by_provider_message: "app_runtime",
    accountant_erase_business: "app_runtime",
    accountant_user_same_business: "",
    accountant_package_guard: "",
    accountant_delivery_insert_guard: "",
    accountant_delivery_update_guard: "",
    accountant_event_append_only_guard: "",
    accountant_event_truncate_guard: "",
  };
  ok("exactly the nine accountant functions exist", fns.length === 9, J(fns.map((f) => f.f)));
  for (const f of fns) {
    const name = String(f.f);
    ok(`EXECUTE on ${name} = {${want[name] || "nobody"}} (never PUBLIC, never a default ACL)`, f.g === want[name] && f.default_acl === false, J(f));
  }
  const definers = fns.filter((f) => f.definer === true).map((f) => f.f).sort();
  ok("SECURITY DEFINER exactly on the three entry points", J(definers) === J(["accountant_delivery_by_provider_message", "accountant_erase_business", "accountant_link_resolve"]), J(definers));
  const flag = rows(await owner.$queryRawUnsafe(
    `SELECT d."defaultEnabled" AS d, p."globalEnabled" AS g, p."emergencyDisabled" AS e FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" = 'accountant_month_close'`))[0];
  ok("flag accountant_month_close is OFF (default false, global false)", flag?.d === false && flag?.g === false && flag?.e === false, J(flag));

  // ── 2. Isolation ───────────────────────────────────────────────────────────────────────────────
  console.log("2. isolation (runtime)");
  for (const t of TABLES) {
    const none = await q(runtime, null, `SELECT count(*) AS n FROM "${t}"`);
    ok(`${t}: no tenant context → nothing visible`, num(none) === 0, J(none));
    const own = await q(runtime, bizB, `SELECT count(*) AS n FROM "${t}" WHERE "businessId" = ${bizB}`);
    ok(`${t}: own rows visible`, num(own) >= 1, J(own));
    const other = await q(runtime, bizA, `SELECT count(*) AS n FROM "${t}" WHERE "businessId" = ${bizB}`);
    ok(`${t}: the other business's rows are invisible`, num(other) === 0, J(other));
  }
  const upOther = await x(runtime, bizA, `UPDATE "AccountantPeriod" SET "status" = 'SENT' WHERE "businessId" = ${bizB}`);
  ok("UPDATE of the other business's period touches nothing", upOther === 0, J(upOther));
  const insOther = await x(runtime, bizA, `INSERT INTO "AccountantPeriod" ("businessId", "periodKey", "status", "createdAt", "updatedAt") VALUES (${bizB}, '2026-08', 'PREPARING', ${NOW}, ${NOW})`);
  ok("INSERT naming the other business is refused (RLS)", refused(insOther, RLS), J(insOther));
  const insNoCtx = await x(runtime, null, `INSERT INTO "AccountantPeriod" ("businessId", "periodKey", "status", "createdAt", "updatedAt") VALUES (${bizB}, '2026-07', 'PREPARING', ${NOW}, ${NOW})`);
  ok("INSERT without a tenant context is refused (RLS)", refused(insNoCtx, RLS), J(insNoCtx));
  for (const t of ["AccountantPeriod", "AccountantPackage", "AccountantDelivery", "AccountantWorkflowEvent"]) {
    const d = await x(runtime, bizB, `DELETE FROM "${t}" WHERE "businessId" = ${bizB}`);
    ok(`${t}: DELETE is denied to the runtime`, refused(d, DENIED), J(d));
  }
  const delOtherRecipient = await x(runtime, bizA, `DELETE FROM "AccountantRecipient" WHERE "businessId" = ${bizB}`);
  ok("AccountantRecipient: DELETE of the other business's row touches nothing", delOtherRecipient === 0, J(delOtherRecipient));
  const pub = await q(runtime, bizB, `SELECT * FROM public.accountant_link_resolve('x', 'y')`);
  ok("the runtime may call the link lookup", Array.isArray(pub), J(pub));

  // ── 3. Cross-business references ───────────────────────────────────────────────────────────────
  console.log("3. cross-business references");
  const crossPkg = await x(owner, null, `INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "createdAt") VALUES (${bizA}, ${periodB}, 9, '${SHA("c")}', 'BUILDING', ${NOW})`);
  ok("a package of A pointing at B's period is refused (composite FK)", refused(crossPkg, FK), J(crossPkg));
  const crossDel = await x(owner, null, `INSERT INTO "AccountantDelivery" ("businessId", "periodId", "packageId", "packageVersion", "packageSha256", "recipientVersion", "recipientName", "recipientEmail", "approvedByUserId", "approvedAt", "incompleteAcknowledged", "openItemCount", "idempotencyKey", "status", "linkPublicId", "linkTokenHash", "linkExpiresAt", "createdAt", "updatedAt")
    VALUES (${bizA}, ${periodA}, ${pkgB}, 1, '${SHA("b")}', 1, 'n', 'x@example.com', ${userA}, ${NOW}, false, 0, '${key("idem")}', 'APPROVED', '${pubId()}', '${SHA("9")}', ${NOW} + interval '1 day', ${NOW}, ${NOW})`);
  ok("a delivery of A naming B's package is refused", refused(crossDel, FK) || refused(crossDel, /ACCOUNTANT_DELIVERY_PACKAGE/), J(crossDel));
  const crossUser = await x(owner, null, `UPDATE "AccountantRecipient" SET "updatedByUserId" = ${userB} WHERE "businessId" = ${bizA}`);
  ok("a user of B on A's recipient is refused (trigger)", refused(crossUser, /ACCOUNTANT_USER_OTHER_BUSINESS/), J(crossUser));

  // ── 4. Packages ────────────────────────────────────────────────────────────────────────────────
  console.log("4. packages");
  const foreignKey = await x(runtime, bizA, `INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "createdAt") VALUES (${bizA}, ${periodA}, 2, '${SHA("1")}', 'BUILDING', ${NOW})`);
  ok("the runtime opens a BUILDING version", foreignKey === 1, J(foreignKey));
  const second = await x(runtime, bizA, `INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "createdAt") VALUES (${bizA}, ${periodA}, 3, '${SHA("2")}', 'BUILDING', ${NOW})`);
  ok("a second BUILDING version of the same period is refused", refused(second, UNIQUE), J(second));
  const stealKey = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'READY', "storageKey" = 'biz/${bizB}/exports/accountant/2026-09/x.zip', "sha256" = '${SHA("3")}', "sizeBytes" = 5, "readyAt" = ${NOW} WHERE "businessId" = ${bizA} AND "version" = 2`);
  ok("a storage key under another business's prefix is refused", refused(stealKey, CHECK), J(stealKey));
  const noObject = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'READY', "readyAt" = ${NOW} WHERE "businessId" = ${bizA} AND "version" = 2`);
  ok("READY without a stored object is refused", refused(noObject, CHECK), J(noObject));
  const seal = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'READY', "storageKey" = 'biz/${bizA}/exports/accountant/2026-09/v2-abc.zip', "sha256" = '${SHA("4")}', "sizeBytes" = 5, "readyAt" = ${NOW} WHERE "businessId" = ${bizA} AND "version" = 2`);
  ok("BUILDING → READY with its own object", seal === 1, J(seal));
  const tamper = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "sha256" = '${SHA("5")}' WHERE "id" = ${pkgA}`);
  ok("a READY package's sha256 cannot change", refused(tamper, /ACCOUNTANT_PACKAGE_SEALED/), J(tamper));
  const tamperKey = await x(owner, null, `UPDATE "AccountantPackage" SET "storageKey" = 'biz/${bizA}/exports/accountant/2026-09/other.zip' WHERE "id" = ${pkgA}`);
  ok("not even the owner can repoint a READY package's object", refused(tamperKey, /ACCOUNTANT_PACKAGE_SEALED/), J(tamperKey));
  const back = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'BUILDING' WHERE "id" = ${pkgA}`);
  ok("READY → BUILDING is refused", refused(back, /ACCOUNTANT_PACKAGE_TRANSITION/), J(back));
  const sup = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'SUPERSEDED', "supersededAt" = ${NOW} WHERE "id" = ${pkgA}`);
  ok("READY → SUPERSEDED is allowed", sup === 1, J(sup));
  const revive = await x(runtime, bizA, `UPDATE "AccountantPackage" SET "status" = 'READY' WHERE "id" = ${pkgA}`);
  ok("SUPERSEDED is final", refused(revive, /ACCOUNTANT_PACKAGE_TRANSITION/) || refused(revive, CHECK), J(revive));
  const pkgA2 = Number(rows(await owner.$queryRawUnsafe(`SELECT "id" FROM "AccountantPackage" WHERE "businessId" = $1 AND "version" = 2`, bizA))[0].id);

  // ── 5. Deliveries ──────────────────────────────────────────────────────────────────────────────
  console.log("5. deliveries");
  const insDel = (over: Record<string, string>) => {
    const v = {
      periodId: String(periodA), packageId: String(pkgA2), packageVersion: "2", sha: `'${SHA("4")}'`, status: "'APPROVED'",
      open: "0", ack: "false", expires: `${NOW} + interval '14 days'`, email: "'cpa-a@example.com'", approver: String(userA), ...over,
    };
    return x(runtime, bizA, `INSERT INTO "AccountantDelivery" ("businessId", "periodId", "packageId", "packageVersion", "packageSha256", "recipientVersion", "recipientName", "recipientEmail", "approvedByUserId", "approvedAt", "incompleteAcknowledged", "openItemCount", "idempotencyKey", "status", "linkPublicId", "linkTokenHash", "linkExpiresAt", "createdAt", "updatedAt")
      VALUES (${bizA}, ${v.periodId}, ${v.packageId}, ${v.packageVersion}, ${v.sha}, 1, 'רו"ח', ${v.email}, ${v.approver}, ${NOW}, ${v.ack}, ${v.open}, '${key("idem")}', ${v.status}, '${pubId()}', '${SHA(String(++seq % 10))}'::text || '', ${v.expires}, ${NOW}, ${NOW})`);
  };
  ok("a delivery born SENDING is refused", refused(await insDel({ status: "'SENDING'" }), /ACCOUNTANT_DELIVERY_BIRTH/));
  ok("a delivery for a superseded package is refused", refused(await insDel({ packageId: String(pkgA), packageVersion: "1", sha: `'${SHA("a")}'` }), /ACCOUNTANT_DELIVERY_PACKAGE/));
  ok("a delivery naming a different sha256 is refused", refused(await insDel({ sha: `'${SHA("6")}'` }), /ACCOUNTANT_DELIVERY_PACKAGE/));
  ok("a delivery naming a different version is refused", refused(await insDel({ packageVersion: "7" }), /ACCOUNTANT_DELIVERY_PACKAGE/));
  ok("D2: open items without the acknowledgement are refused", refused(await insDel({ open: "3", ack: "false" }), CHECK));
  ok("a link living longer than 15 days is refused", refused(await insDel({ expires: `${NOW} + interval '20 days'` }), CHECK));
  ok("an address that is not lower-case is refused", refused(await insDel({ email: "'CPA@Example.com'" }), CHECK));
  const good = await insDel({ open: "3", ack: "true" });
  ok("D2: open items WITH the acknowledgement are accepted", good === 1, J(good));
  ok("a second approval while one is in flight is refused", refused(await insDel({}), UNIQUE));
  const dA = Number(rows(await owner.$queryRawUnsafe(`SELECT "id" FROM "AccountantDelivery" WHERE "businessId" = $1 ORDER BY "id" DESC LIMIT 1`, bizA))[0].id);
  const frozen: Array<[string, string]> = [
    ["packageSha256", `'${SHA("7")}'`], ["packageId", String(pkgA)], ["recipientVersion", "2"], ["approvedAt", `${NOW} - interval '1 day'`],
    ["incompleteAcknowledged", "false"], ["openItemCount", "0"], ["linkTokenHash", `'${SHA("8")}'`], ["linkExpiresAt", `${NOW} + interval '1 day'`],
  ];
  for (const [col, val] of frozen) {
    const r = await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "${col}" = ${val} WHERE "id" = ${dA}`);
    ok(`approval column ${col} is frozen`, refused(r, /ACCOUNTANT_DELIVERY_FROZEN/) || refused(r, CHECK), J(r));
  }
  ok("the recipient snapshot cannot be repointed", refused(await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "recipientEmail" = 'other@example.com' WHERE "id" = ${dA}`), /ACCOUNTANT_DELIVERY_FROZEN/));
  ok("APPROVED → ACCEPTED (skipping SENDING) is refused", refused(await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "status" = 'ACCEPTED' WHERE "id" = ${dA}`), /ACCOUNTANT_DELIVERY_TRANSITION/));
  ok("APPROVED → SENDING", (await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "status" = 'SENDING', "attempts" = 1 WHERE "id" = ${dA}`)) === 1);
  ok("SENDING → ACCEPTED", (await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "status" = 'ACCEPTED', "provider" = 'resend', "providerMessageId" = 'msg_lab_1', "acceptedAt" = ${NOW} WHERE "id" = ${dA}`)) === 1);
  ok("ACCEPTED → APPROVED (backwards) is refused", refused(await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "status" = 'APPROVED' WHERE "id" = ${dA}`), /ACCOUNTANT_DELIVERY_TRANSITION/));
  ok("the download count cannot shrink", refused(await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "downloadCount" = -1 WHERE "id" = ${dA}`), /ACCOUNTANT_DELIVERY_FROZEN|check constraint/i));
  ok("revoking the link", (await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "linkRevokedAt" = ${NOW} WHERE "id" = ${dA}`)) === 1);
  ok("a revoked link stays revoked", refused(await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "linkRevokedAt" = NULL WHERE "id" = ${dA}`), /ACCOUNTANT_DELIVERY_FROZEN/));
  ok("the recipient snapshot can be erased", (await x(runtime, bizA, `UPDATE "AccountantDelivery" SET "recipientName" = NULL, "recipientEmail" = NULL WHERE "id" = ${dA}`)) === 1);
  const sendErased = await x(owner, null, `UPDATE "AccountantDelivery" SET "status" = 'SENDING', "recipientEmail" = NULL WHERE "id" = ${deliveryB}`);
  ok("SENDING with no address is refused", refused(sendErased, /ACCOUNTANT_DELIVERY_ERASED/), J(sendErased));

  // ── 6. Append-only trail and closed payloads ───────────────────────────────────────────────────
  console.log("6. trail and closed payloads");
  ok("the runtime writes the trail", (await x(runtime, bizA, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "periodId", "eventType", "actor", "actorUserId", "occurredAt", "payload", "idempotencyKey") VALUES (${bizA}, ${periodA}, 'DELIVERY_APPROVED', 'OWNER_USER', ${userA}, ${NOW}, '{"openItems":3,"incompleteAcknowledged":true}', '${key("ev")}')`)) === 1);
  ok("runtime UPDATE of the trail is denied", refused(await x(runtime, bizA, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "businessId" = ${bizA}`), DENIED));
  ok("the OWNER's UPDATE of the trail is refused by the trigger", refused(await x(owner, null, `UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "businessId" = ${bizB}`), /ACCOUNTANT_EVENT_APPEND_ONLY/));
  ok("the OWNER's DELETE of the trail is refused by the trigger", refused(await x(owner, null, `DELETE FROM "AccountantWorkflowEvent" WHERE "businessId" = ${bizB}`), /ACCOUNTANT_EVENT_APPEND_ONLY/));
  ok("TRUNCATE of the trail is refused", refused(await x(owner, null, `TRUNCATE "AccountantWorkflowEvent"`), /ACCOUNTANT_EVENT_APPEND_ONLY|cannot truncate/i));
  const marker = await inTx(runtime, bizA, async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('dubiz.accountant_erasure', 'on', true)`);
    return tx.$executeRawUnsafe(`UPDATE "AccountantWorkflowEvent" SET "actorUserId" = NULL WHERE "businessId" = ${bizA}`);
  });
  ok("the erasure marker set by the runtime opens nothing", refused(marker, DENIED), J(marker));
  const ownerMarker = await inTx(owner, null, async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('dubiz.accountant_erasure', 'on', true)`);
    return tx.$executeRawUnsafe(`UPDATE "AccountantWorkflowEvent" SET "eventType" = 'NOTIFIED' WHERE "businessId" = ${bizB}`);
  });
  ok("even with the marker, nothing but actorUserId → NULL passes the trigger", refused(ownerMarker, /ACCOUNTANT_EVENT_APPEND_ONLY/), J(ownerMarker));
  ok("free text in the trail payload is refused", refused(await x(runtime, bizA, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "eventType", "actor", "occurredAt", "payload", "idempotencyKey") VALUES (${bizA}, 'NOTIFIED', 'SYSTEM', ${NOW}, '{"note":"שלום לרואה החשבון"}', '${key("ev")}')`), CHECK));
  ok("free text in readiness is refused", refused(await x(runtime, bizA, `UPDATE "AccountantPeriod" SET "readiness" = '{"note":"vendor name here"}' WHERE "id" = ${periodA}`), CHECK));
  ok("a SYSTEM event cannot name a user", refused(await x(runtime, bizA, `INSERT INTO "AccountantWorkflowEvent" ("businessId", "eventType", "actor", "actorUserId", "occurredAt", "idempotencyKey") VALUES (${bizA}, 'NOTIFIED', 'SYSTEM', ${userA}, ${NOW}, '${key("ev")}')`), CHECK));

  // ── 7. Bootstrap lookups and erasure ───────────────────────────────────────────────────────────
  console.log("7. lookups and erasure");
  const link = rows(await owner.$queryRawUnsafe(`SELECT "linkPublicId" AS p, "linkTokenHash" AS h FROM "AccountantDelivery" WHERE "id" = $1`, deliveryB))[0];
  const hit = await q(runtime, null, `SELECT * FROM public.accountant_link_resolve($1, $2)`, link.p, link.h);
  ok("the link lookup resolves (business, delivery) on an exact match — without a tenant context", rows(hit).length === 1 && Number(rows(hit)[0].businessId) === bizB && Number(rows(hit)[0].deliveryId) === deliveryB, J(hit));
  ok("the link lookup returns ids only", J(Object.keys(rows(hit)[0] ?? {}).sort()) === J(["businessId", "deliveryId"]));
  ok("a right public id with a wrong hash resolves nothing", rows(await q(runtime, null, `SELECT * FROM public.accountant_link_resolve($1, $2)`, link.p, SHA("0"))).length === 0);
  ok("a malformed public id resolves nothing", rows(await q(runtime, null, `SELECT * FROM public.accountant_link_resolve($1, $2)`, "' OR 1=1 --", link.h)).length === 0);
  const msg = await q(runtime, null, `SELECT * FROM public.accountant_delivery_by_provider_message('resend', 'msg_lab_1')`);
  ok("the provider lookup maps a message id to its delivery", rows(msg).length === 1 && Number(rows(msg)[0].deliveryId) === dA, J(msg));
  ok("the provider lookup ignores another provider", rows(await q(runtime, null, `SELECT * FROM public.accountant_delivery_by_provider_message('other', 'msg_lab_1')`)).length === 0);
  const noCtx = await q(runtime, null, `SELECT public.accountant_erase_business() AS n`);
  ok("erasure refuses without a tenant context", refused(noCtx, /ACCOUNTANT_ERASURE_NO_CONTEXT/), J(noCtx));
  const notDeleting = await q(runtime, bizB, `SELECT public.accountant_erase_business() AS n`);
  ok("erasure refuses while the business is not being deleted", refused(notDeleting, /ACCOUNTANT_ERASURE_NOT_DELETING/), J(notDeleting));
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = $1`, bizB);
  const erased = await inTx(runtime, bizB, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "AccountantDelivery" SET "recipientName" = NULL, "recipientEmail" = NULL, "linkRevokedAt" = ${NOW} WHERE "businessId" = ${bizB} AND "linkRevokedAt" IS NULL`);
    await tx.$executeRawUnsafe(`DELETE FROM "AccountantRecipient" WHERE "businessId" = ${bizB}`);
    return tx.$queryRawUnsafe(`SELECT public.accountant_erase_business() AS n`) as Promise<Rows>;
  });
  ok("erasure (adapter writes + function) runs for the business being deleted", Array.isArray(erased), J(erased));
  const after = rows(await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" = $1) AS r,
            (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" = $1 AND ("recipientEmail" IS NOT NULL OR "linkRevokedAt" IS NULL)) AS d,
            (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "businessId" = $1 AND "actorUserId" IS NOT NULL) AS e,
            (SELECT count(*) FROM "AccountantPackage" WHERE "businessId" = $1) AS p,
            (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" = $2) AS other`, bizB, bizA))[0];
  ok("after erasure: no recipient, no address, no live link, no acting user; packages retained; the other business untouched",
    Number(after.r) === 0 && Number(after.d) === 0 && Number(after.e) === 0 && Number(after.p) === 1 && Number(after.other) === 1, J(after));
  ok("the erased business's link resolves nothing that could open (revoked)",
    rows(await owner.$queryRawUnsafe(`SELECT 1 FROM "AccountantDelivery" WHERE "id" = $1 AND "linkRevokedAt" IS NOT NULL`, deliveryB)).length === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
    await runtime.$disconnect();
  });
