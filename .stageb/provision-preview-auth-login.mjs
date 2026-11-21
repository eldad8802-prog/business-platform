/**
 * D2 / AUTH BOUNDARY STAGE B — the Preview auth LOGIN identity.
 *
 * Creates `app_auth_prev_rehearsal`: LOGIN, member of `app_auth` and nothing
 * else, owning nothing. The group already carries the privilege contract, so
 * this role's only job is to hold a credential and inherit it.
 *
 * The password exists only inside this process. It is generated here, applied,
 * verified with the NEW credential, and then written to STDOUT so it can be
 * piped straight into `vercel env add`. Every human-readable line goes to
 * STDERR, which keeps the one channel carrying the secret free of anything else.
 *
 * ALTER ROLE rather than DROP/CREATE on re-run: Neon's pooler caches role OIDs,
 * and recreating a role under the same name leaves it handing out stale ones.
 *
 * PREVIEW ONLY — the Production endpoints are refused outright.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const GROUP = "app_auth";
const ROLE = "app_auth_prev_rehearsal";
const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];
const EXPECT_HOST = "ep-wispy-dawn-amr74bwz";

const log = (s) => process.stderr.write(s + "\n");

async function main() {
  const ownerUrl = readFileSync(process.argv[2], "utf8").trim();
  for (const d of DENY) {
    if (ownerUrl.includes(d)) { log("REFUSING: production deny-list hit"); process.exit(2); }
  }
  if (!ownerUrl.includes(EXPECT_HOST)) { log(`REFUSING: host is not ${EXPECT_HOST}`); process.exit(2); }

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const who = await owner.$queryRawUnsafe(`SELECT current_database() d, current_user::text u`);
  log(`  target: db=${who[0].d} as=${who[0].u}`);
  if (who[0].d !== "neondb") { log("REFUSING: unexpected database"); process.exit(2); }

  // An alphabet that needs no escaping in a SQL literal or a URI userinfo field,
  // so neither the DDL nor the connection string can be malformed by the secret.
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
    // NOSUPERUSER / NOBYPASSRLS / NOREPLICATION can only be CHANGED by a
    // superuser, and neondb_owner is not one — re-asserting them on an existing
    // role fails 42501 even when they already hold. They are proven by the
    // verification below instead, which measures rather than assumes.
    await owner.$executeRawUnsafe(`ALTER ROLE ${ROLE} WITH PASSWORD '${pw}'`);
    await owner.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOCREATEDB NOCREATEROLE INHERIT`);
    log(`  ${ROLE} existed — password rotated, alterable attributes re-asserted`);
  }
  await owner.$executeRawUnsafe(`GRANT ${GROUP} TO ${ROLE}`);
  await owner.$disconnect();

  const host = `${EXPECT_HOST}-pooler.c-5.us-east-1.aws.neon.tech`;
  const uri = `postgresql://${ROLE}:${pw}@${host}/neondb?sslmode=require`;

  // Prove the credential works and matches the contract BEFORE it becomes the
  // Preview variable, so a bad provisioning fails here rather than as a broken
  // login on a deployment nobody can reach to debug.
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
