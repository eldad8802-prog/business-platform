/**
 * D2 / AUTH BOUNDARY STAGE B — what the Preview auth identity can and cannot do.
 *
 * Measured as the LOGIN role itself, over the network, because that is the
 * identity the application will hold. Asserting on the `app_auth` group alone
 * would miss a direct grant handed to the LOGIN role, and it is the LOGIN role
 * whose credential goes into the environment.
 *
 * The positives and the negatives matter equally. A contract that is too narrow
 * breaks login; one that is too broad leaves the boundary where it was. So each
 * required capability is exercised for real, and each forbidden one is asserted
 * to be refused — not merely absent from a catalog listing.
 *
 * Writes are confined to synthetic rows this run creates and removes. No
 * password hash, email or other personal data is read or printed.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const ROLE = process.env.AUTH_ROLE_NAME ?? "app_auth_prev_rehearsal";
const TAG = `stageb-${process.env.STAGEB_STAMP ?? Date.now()}`;
const db = new PrismaClient({ datasourceUrl: readFileSync(process.env.AUTH_URL_FILE, "utf8").trim() });

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return String(e?.message ?? e); }
}
const denied = (m) => m !== null && /permission denied|must be owner|not authorized|insufficient/i.test(m);

async function main() {
  // ---- identity ------------------------------------------------------------
  console.log("== identity ==");
  const w = await db.$queryRawUnsafe(
    `SELECT current_user::text u, current_setting('is_superuser') su, r.rolbypassrls bypass,
            r.rolcreatedb cdb, r.rolcreaterole crole, r.rolreplication repl, r.rolinherit inh,
            (SELECT count(*)::int FROM pg_class c
              WHERE c.relnamespace='public'::regnamespace AND c.relowner=r.oid) owns,
            (SELECT COALESCE(string_agg(g.rolname, ',' ORDER BY g.rolname),'')
               FROM pg_auth_members am JOIN pg_roles g ON g.oid=am.roleid
              WHERE am.member=r.oid) memberships
       FROM pg_roles r WHERE r.rolname=current_user`);
  const W = w[0];
  console.log(`  ${W.u} superuser=${W.su} bypassrls=${W.bypass} owns=${W.owns} memberships=[${W.memberships}]`);
  ok("connected as the Preview auth LOGIN role", W.u === ROLE);
  ok("NOSUPERUSER", W.su === "off");
  ok("NOBYPASSRLS", W.bypass === false);
  ok("NOCREATEDB / NOCREATEROLE / NOREPLICATION", !W.cdb && !W.crole && !W.repl);
  ok("INHERIT", W.inh === true);
  ok("owns ZERO relations", W.owns === 0);
  ok("member of app_auth and NOTHING else", W.memberships === "app_auth");
  for (const forbidden of ["app_runtime", "app_admin", "app_ctlplane"]) {
    const h = await db.$queryRawUnsafe(`SELECT pg_has_role(current_user, $1, 'USAGE') AS m`, forbidden);
    ok(`NOT a member of ${forbidden}`, h[0].m === false);
  }

  // ---- the capabilities auth genuinely needs -------------------------------
  console.log("\n== required capabilities (exercised, not assumed) ==");
  const sel = await refused(() => db.$queryRawUnsafe(
    `SELECT count(*)::int n FROM "User"`));
  ok("SELECT on User works (login resolves by email before any tenant is known)", sel === null, sel ?? "");
  const selB = await refused(() => db.$queryRawUnsafe(`SELECT count(*)::int n FROM "Business"`));
  ok("SELECT on Business works (login includes the tenant row)", selB === null, selB ?? "");

  // signup: Business then User, one transaction, on this identity.
  let bizId = null;
  const signup = await refused(() => db.$transaction(async (tx) => {
    const b = await tx.$queryRawUnsafe(
      `INSERT INTO "Business" ("name","createdAt","updatedAt") VALUES ($1, now(), now()) RETURNING id`,
      `${TAG}-biz`);
    bizId = b[0].id;
    await tx.$executeRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,now(),now())`,
      `${TAG}@example.invalid`, "not-a-real-hash", `${TAG}-user`, bizId);
  }));
  ok("signup INSERT of Business + User in one transaction works", signup === null, signup ?? "");
  ok("sequence USAGE alone is enough for nextval (no UPDATE on the sequence)",
    signup === null && bizId !== null);

  // the three columns login and logout actually write
  const upd = await refused(() => db.$executeRawUnsafe(
    `UPDATE "User" SET "lastLoginAt"=now(), "loginCount"="loginCount"+1,
            "tokenVersion"="tokenVersion"+1, "updatedAt"=now()
      WHERE email=$1`, `${TAG}@example.invalid`));
  ok("UPDATE of lastLoginAt/loginCount/tokenVersion/updatedAt works", upd === null, upd ?? "");

  // ---- the capabilities it must NOT have -----------------------------------
  console.log("\n== forbidden capabilities (each proven refused) ==");
  ok("DELETE on User is refused",
    denied(await refused(() => db.$executeRawUnsafe(`DELETE FROM "User" WHERE id = -1`))));
  ok("DELETE on Business is refused",
    denied(await refused(() => db.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = -1`))));
  ok("UPDATE on Business is refused",
    denied(await refused(() => db.$executeRawUnsafe(`UPDATE "Business" SET name=name WHERE id = -1`))));
  // The column list is the boundary: writing a column outside it must fail even
  // though UPDATE on the table is granted for other columns.
  ok("UPDATE of User.password is refused (outside the granted column list)",
    denied(await refused(() => db.$executeRawUnsafe(
      `UPDATE "User" SET password='x' WHERE id = -1`))));
  ok("UPDATE of User.email is refused",
    denied(await refused(() => db.$executeRawUnsafe(`UPDATE "User" SET email='x' WHERE id = -1`))));
  ok("UPDATE of User.businessId is refused (no tenant reassignment)",
    denied(await refused(() => db.$executeRawUnsafe(
      `UPDATE "User" SET "businessId"=-1 WHERE id = -1`))));
  // PLATFORM_ADMIN, because that is the actual escalation. An invalid enum
  // literal would be rejected by the parser before the privilege check ran, and
  // the test would pass on a type error while proving nothing about privilege.
  ok("UPDATE of User.role to PLATFORM_ADMIN is refused (no escalation through the row)",
    denied(await refused(() => db.$executeRawUnsafe(
      `UPDATE "User" SET role='PLATFORM_ADMIN' WHERE id = -1`))));

  console.log("\n== reach beyond the auth contract ==");
  for (const t of ["Customer", "Conversation", "BillingDocument", "PaymentRequest", "InventoryItem"]) {
    ok(`no SELECT on the tenant table ${t}`,
      denied(await refused(() => db.$queryRawUnsafe(`SELECT count(*) FROM "${t}"`))));
  }
  ok("cannot read the migration ledger",
    denied(await refused(() => db.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`))));
  ok("cannot TRUNCATE User",
    (await refused(() => db.$executeRawUnsafe(`TRUNCATE "User"`))) !== null);
  ok("cannot ALTER User",
    (await refused(() => db.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN x_stageb TEXT`))) !== null);
  ok("cannot CREATE in schema public",
    (await refused(() => db.$executeRawUnsafe(`CREATE TABLE stageb_probe (id int)`))) !== null);
  // Asserted on the EFFECT, not on an exception. PostgreSQL answers a GRANT from
  // a grantor without grant option with a WARNING and no error, so "it threw" is
  // the wrong question — the right one is whether the privilege moved.
  await refused(() => db.$executeRawUnsafe(`GRANT DELETE ON "User" TO app_auth`));
  const afterGrant = await db.$queryRawUnsafe(
    `SELECT has_table_privilege('app_auth','public."User"','DELETE') g,
            has_table_privilege(current_user,'public."User"','DELETE') s`);
  ok("a self-GRANT of DELETE changes nothing (no privilege was actually acquired)",
    afterGrant[0].g === false && afterGrant[0].s === false, JSON.stringify(afterGrant[0]));
  ok("cannot become a member of app_runtime",
    (await refused(() => db.$executeRawUnsafe(`GRANT app_runtime TO ${ROLE}`))) !== null);
  const sch = await db.$queryRawUnsafe(
    `SELECT has_schema_privilege(current_user,'public','USAGE') u,
            has_schema_privilege(current_user,'public','CREATE') c`);
  ok("schema USAGE yes, CREATE no", sch[0].u === true && sch[0].c === false);

  // ---- cleanup: remove only what this run created --------------------------
  console.log("\n== cleanup ==");
  // This identity cannot DELETE by design, which is the point — so the rows are
  // left for the owner-side cleanup below and reported honestly if they remain.
  const left = await db.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "User" WHERE email=$1) u,
            (SELECT count(*)::int FROM "Business" WHERE name=$2) b`,
    `${TAG}@example.invalid`, `${TAG}-biz`);
  console.log(`  synthetic rows left for owner cleanup: User=${left[0].u} Business=${left[0].b} (tag ${TAG})`);

  console.log(`\n[stageb] PASS=${pass} FAIL=${fail}`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", String(e?.message ?? e).slice(0, 400));
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
