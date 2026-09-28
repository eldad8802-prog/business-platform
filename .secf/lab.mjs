/**
 * SEC-F lab — a fresh, isolated PostgreSQL database per run.
 *
 * The lab is built the way the repository's other DB batteries build theirs:
 * `prisma db push` for the tables (schema.prisma is repository truth; the
 * migration history is not replayable from empty — pre-existing, separate debt),
 * then EVERY row-level-security / role statement the repository ships replayed
 * from the migration files in order (ad2a's dollar-quote-aware splitter), so the
 * audit and fiscal tables carry exactly the tenant rules main ships. The SEC-F
 * migration is excluded from that replay and applied whole, afterwards, by the
 * battery — which is what lets the battery first reproduce the gap.
 *
 * Identities, all fresh per run where they can be:
 *   secf_owner  LOGIN NOSUPERUSER BYPASSRLS — owns every table (the shape of a
 *               managed-Postgres migration owner: not a superuser, bypasses RLS)
 *   secf_rt     LOGIN NOSUPERUSER NOBYPASSRLS, member of app_runtime, owns nothing
 *   secf_adm    LOGIN NOSUPERUSER NOBYPASSRLS, member of app_admin, owns nothing
 * and the production default privilege (owner grants app_runtime arwd on every
 * new table) is reproduced before the schema exists, so the runtime starts
 * exactly as over-granted as Production measured it (see 20260924180000).
 *
 * Synthetic credentials only. Refuses any URL that is not loopback.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { splitStatements } from "../.ad2a/migration-state.mjs";

export const SECF_MIGRATION =
  "prisma/migrations/20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events/migration.sql";

const DB = process.env.SECF_LAB_DB || "secf_lab";
const PW = "secf_lab_synthetic_pw";

export function superUrl() {
  const url = process.env.SECF_SUPER_URL;
  if (!url) throw new Error("SETUP: SECF_SUPER_URL is required (a loopback superuser URL)");
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(`SETUP: refusing non-loopback database host ${u.hostname}`);
  }
  return u;
}

export function roleUrl(user, db = DB) {
  const u = superUrl();
  u.username = user;
  u.password = PW;
  u.pathname = `/${db}`;
  return u.toString();
}

async function superClient(db) {
  const u = superUrl();
  u.pathname = `/${db}`;
  return new PrismaClient({ datasourceUrl: u.toString() });
}

export async function freshLab() {
  const sup = await superClient("postgres");
  try {
    await sup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`
    );
    await sup.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DB}`);
    for (const r of ["app_runtime", "app_auth", "app_admin", "app_ctlplane"]) {
      await sup.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
           CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
         END IF; END $do$`
      );
    }
    const logins = [
      ["secf_owner", "NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB", null],
      ["secf_rt", "NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB", "app_runtime"],
      ["secf_adm", "NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB", "app_admin"],
    ];
    for (const [name, attrs, group] of logins) {
      await sup.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
           CREATE ROLE ${name} LOGIN PASSWORD '${PW}' ${attrs};
         END IF; END $do$`
      );
      await sup.$executeRawUnsafe(`ALTER ROLE ${name} WITH LOGIN PASSWORD '${PW}' ${attrs}`);
      if (group) await sup.$executeRawUnsafe(`GRANT ${group} TO ${name}`);
    }
    await sup.$executeRawUnsafe(`CREATE DATABASE ${DB} OWNER secf_owner`);
  } finally {
    await sup.$disconnect();
  }

  // Inside the new database, as superuser: the schema belongs to the owner, and
  // the owner's default privilege hands app_runtime a,r,w,d on every new table.
  const supDb = await superClient(DB);
  try {
    await supDb.$executeRawUnsafe(`ALTER SCHEMA public OWNER TO secf_owner`);
    await supDb.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime, app_auth, app_admin, app_ctlplane`);
    await supDb.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE secf_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime`
    );
    await supDb.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE secf_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime`
    );
  } finally {
    await supDb.$disconnect();
  }

  const ownerUrl = roleUrl("secf_owner");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl },
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  // Replay the repository's RLS surface, excluding the SEC-F migration.
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  let replayed = 0;
  try {
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d/.test(d)).sort();
    for (const d of dirs) {
      if (`prisma/migrations/${d}/migration.sql` === SECF_MIGRATION) continue;
      let sql;
      try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
      for (const st of splitStatements(sql)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(st)) continue;
        if (/^DO\s/i.test(st)) continue;
        try { await owner.$executeRawUnsafe(st); replayed++; } catch { /* table absent from schema or already present */ }
      }
    }
  } finally {
    await owner.$disconnect();
  }
  if (replayed < 50) throw new Error(`SETUP: replayed only ${replayed} RLS statements`);
  return { ownerUrl, rtUrl: roleUrl("secf_rt"), admUrl: roleUrl("secf_adm"), replayed };
}

/** Apply a SQL file as one transaction with the owner identity (what `migrate deploy` does). */
export function applyMigrationFile(file, ownerUrl) {
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "db", "execute", "--file", file, "--url", ownerUrl], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}
