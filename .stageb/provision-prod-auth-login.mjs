/**
 * D2 / AUTH BOUNDARY STAGE C — the Production auth LOGIN identity.
 *
 * Creates `app_auth_prod`: LOGIN, member of `app_auth` and nothing else, owning
 * nothing. The group already carries the privilege contract proven in Preview,
 * so this role's only job is to hold a credential and inherit it.
 *
 * Stage C prepares; it does not activate. The role exists and the credential is
 * configured, but `AUTH_PLANE_ENABLED` stays off, so the application keeps
 * running its auth through the legacy path until a separate authorization.
 *
 * The password exists only inside this process: generated, applied, verified
 * with the new credential, then written to STDOUT for `vercel env add`. All
 * human-readable output goes to STDERR, keeping the one channel that carries
 * the secret free of anything else.
 *
 * This is the ONE script here that deliberately targets Production, so the
 * usual deny-list is inverted into a REQUIRE-list: it refuses to run anywhere
 * that is not the Production endpoint, which is the failure mode that would
 * otherwise put a Production credential into a Preview environment.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const GROUP = "app_auth";
const ROLE = "app_auth_prod";
const REQUIRE_HOST = "ep-flat-brook-am4bhq1y";

const log = (s) => process.stderr.write(s + "\n");

async function main() {
  const ownerUrl = readFileSync(process.argv[2], "utf8").trim();
  if (!ownerUrl.includes(REQUIRE_HOST)) {
    log(`REFUSING: this provisions PRODUCTION and the target is not ${REQUIRE_HOST}`);
    process.exit(2);
  }

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const who = await owner.$queryRawUnsafe(
    `SELECT current_database() d, current_user::text u,
            (SELECT count(*)::int FROM "_prisma_migrations") ledger`);
  log(`  target: db=${who[0].d} as=${who[0].u} migrations=${who[0].ledger}`);
  if (who[0].d !== "neondb") { log("REFUSING: unexpected database"); process.exit(2); }
  // The migration ledger is the discriminator that actually distinguishes the
  // branches: Preview's is empty, Production's is not. Names and flags in Neon
  // have proven unreliable for this.
  if (who[0].ledger < 100) {
    log(`REFUSING: ledger=${who[0].ledger} does not look like Production`);
    process.exit(2);
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let pw = "";
  for (const b of randomBytes(48)) pw += alphabet[b % alphabet.length];

  const exists = await owner.$queryRawUnsafe(
    `SELECT count(*)::int n FROM pg_roles WHERE rolname=$1`, ROLE);
  if (exists[0].n === 0) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${ROLE} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
    log(`  created ${ROLE}`);
  } else {
    await owner.$executeRawUnsafe(`ALTER ROLE ${ROLE} WITH PASSWORD '${pw}'`);
    await owner.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOCREATEDB NOCREATEROLE INHERIT`);
    log(`  ${ROLE} existed — password rotated, alterable attributes re-asserted`);
  }
  await owner.$executeRawUnsafe(`GRANT ${GROUP} TO ${ROLE}`);
  await owner.$disconnect();

  const host = `${REQUIRE_HOST}-pooler.c-5.us-east-1.aws.neon.tech`;
  const uri = `postgresql://${ROLE}:${pw}@${host}/neondb?sslmode=require`;

  const probe = new PrismaClient({ datasourceUrl: uri });
  const v = await probe.$queryRawUnsafe(
    `SELECT current_user::text u, current_setting('is_superuser') su, r.rolbypassrls bypass,
            r.rolcreatedb cdb, r.rolcreaterole crole, r.rolreplication repl, r.rolinherit inh,
            (SELECT count(*)::int FROM pg_class c
              WHERE c.relnamespace='public'::regnamespace AND c.relowner=r.oid) owns,
            (SELECT COALESCE(string_agg(g.rolname, ',' ORDER BY g.rolname),'')
               FROM pg_auth_members am JOIN pg_roles g ON g.oid=am.roleid
              WHERE am.member=r.oid) memberships
       FROM pg_roles r WHERE r.rolname = current_user`);
  const V = v[0];
  log(`  verified: user=${V.u} superuser=${V.su} bypassrls=${V.bypass} owns=${V.owns} memberships=[${V.memberships}]`);
  const good = V.u === ROLE && V.su === "off" && V.bypass === false && V.cdb === false &&
    V.crole === false && V.repl === false && V.inh === true && V.owns === 0 &&
    V.memberships === GROUP;
  await probe.$disconnect();
  if (!good) { log("REFUSING: the LOGIN role does not match the required contract"); process.exit(1); }

  log("  contract OK — emitting the URI on stdout (never shown, never stored)");
  process.stdout.write(uri);
}

main().catch((e) => { log("FATAL: " + String(e?.message ?? e).slice(0, 300)); process.exit(1); });
