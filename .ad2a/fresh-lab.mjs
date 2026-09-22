/**
 * AD-2A — one disposable laboratory per proof.
 *
 * Usage:  node .ad2a/fresh-lab.mjs <label> [--keep] -- <command> [args...]
 *
 * WHY THIS EXISTS
 *
 * The battery used to run against whatever database it was pointed at. In CI that
 * was one container for the whole job: the green run, then every negative proof,
 * one after another, each inheriting the row-level security, policies and grants
 * the previous one left. A proof that REMOVES something — a contract entry, a GRANT
 * — then passed on leftovers. Two such false greens were reproduced (a Conversation
 * contract entry, a Notification GRANT).
 *
 * WHAT IT DOES
 *
 * For every invocation, before the command runs:
 *   1. a NEW database, named for this proof and nothing else;
 *   2. a NEW runtime role, same nonce, LOGIN / NOSUPERUSER / NOBYPASSRLS, no grants;
 *   3. the schema pushed into that database from `prisma/schema.prisma`;
 *   4. a freshness nonce written as the database's comment.
 * The command gets the identity in AD2A_FRESH_DB / AD2A_FRESH_NONCE / AD2A_RT_ROLE /
 * AD2A_RT_PW, and the battery MEASURES that it is fresh rather than trusting this
 * script to have done it (`lab-state.mjs`).
 *
 * Isolation does NOT depend on teardown. Teardown runs when it can, but a proof that
 * is killed — or a harness that is — leaves its database and role behind under a name
 * no later proof will ever use. The next proof starts from a new database regardless.
 * `--keep` skips teardown on purpose, which is how that is demonstrated.
 *
 * `app_admin` is created NOLOGIN if absent: the contract carries Production's
 * `TO app_admin` read policies, and a policy cannot name a role that does not exist.
 * It is never granted anything.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
  console.error("usage: node .ad2a/fresh-lab.mjs <label> [--keep] -- <command> [args...]");
  process.exit(2);
}
const label = argv[0].toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 20);
const keep = argv.slice(1, sep).includes("--keep");
const [cmd, ...args] = argv.slice(sep + 1);

const base = process.env.AD2A_ADMIN_URL ?? process.env.DIRECT_URL;
if (!base) throw new Error("AD2A_ADMIN_URL (or DIRECT_URL) must point at the lab cluster");
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(base)) throw new Error("DENY: fresh-lab runs only against a local laboratory cluster");

const nonce = `${label}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
const db = `ad2a_${nonce}`;
const role = `ad2a_rt_${nonce}`;
const pw = crypto.randomBytes(18).toString("hex");
const withDb = (u, name) => {
  const x = new URL(u);
  x.pathname = `/${name}`;
  return x.toString();
};
const ownerUrl = withDb(base, db);

const admin = new PrismaClient({ datasourceUrl: withDb(base, "postgres") });
const sh = (s) => admin.$executeRawUnsafe(s);

console.log(`[fresh-lab] ${label}: database ${db}, role ${role}`);
await sh(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
await sh(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN CREATE ROLE app_admin NOLOGIN; END IF; END $$`);
await sh(`CREATE DATABASE ${db}`);
await sh(`COMMENT ON DATABASE ${db} IS 'ad2a-fresh:${nonce}'`);

const env = {
  ...process.env,
  DATABASE_URL: ownerUrl,
  DIRECT_URL: ownerUrl,
  AD2A_FRESH_NONCE: nonce,
  AD2A_FRESH_DB: db,
  AD2A_RT_ROLE: role,
  AD2A_RT_PW: pw,
};
const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], { env, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
if (push.status !== 0) {
  console.error(`[fresh-lab] schema push failed (${push.status})`);
  process.exit(1);
}

const run = spawnSync(cmd, args, { env, stdio: "inherit", shell: process.platform === "win32" });
const code = run.status ?? 1;

if (keep) {
  console.log(`[fresh-lab] --keep: ${db} and ${role} left in place`);
} else {
  try {
    await sh(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await sh(`DROP ROLE IF EXISTS ${role}`);
  } catch (e) {
    // Never fatal: isolation comes from the NEW database the next proof gets, not
    // from this one being removed.
    console.log(`[fresh-lab] teardown incomplete (${String(e.message).split("\n")[0]}) — harmless to the next proof`);
  }
}
await admin.$disconnect();
process.exit(code);
