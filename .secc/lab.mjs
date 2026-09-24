/**
 * sec(C) — disposable PostgreSQL laboratories built from the SHIPPED migrations.
 *
 * Unlike the schema-push labs elsewhere in this repository, every sec(C) lab is
 * built by `prisma migrate deploy` (the path Production takes), then the repo's
 * per-environment grant scripts (scripts/security/*-grants.sql) are applied — so
 * RLS, FORCE, policies, column grants and functions are the migrations' own, not a
 * re-creation.
 *
 * ONE KNOWN REPLAY DEFECT, handled openly: 20260210120000_billing_invoice_profile_fields
 * is back-dated ahead of 20260329225659_init and cannot replay from empty (it
 * ALTERs a table init creates). The lab copies the migrations to a temp dir, gives
 * that one directory a name that sorts after init, deploys, and then restores its
 * original name in _prisma_migrations so the ledger matches Production's.
 *
 * ISOLATION. One template database per job (base migrations + grants), then one
 * NEW database per proof, cloned from the template, with the sec(C) migrations
 * deployed onto the clone and NEW per-proof LOGIN roles (NOSUPERUSER NOBYPASSRLS,
 * non-owner) that are members of the app_* groups. Nothing a proof changes can
 * reach another proof. Local clusters only.
 *
 * Library: import { newLab, dropLab, psqlFile, q } from "./lab.mjs"
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BACKDATED = "20260210120000_billing_invoice_profile_fields";
const BACKDATED_AS = "20260329225660_billing_invoice_profile_fields";
export const SEC_C_PREFIX = "2026092611";

export const PSQL = process.env.PSQL ?? "psql";
const ADMIN_URL = process.env.SECC_PG_URL;
if (!ADMIN_URL) throw new Error("SECC_PG_URL must point at the local lab cluster (maintenance DB)");
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(ADMIN_URL)) throw new Error("DENY: sec(C) labs run only against a local cluster");

export const withDb = (u, name, user, pw) => {
  const x = new URL(u);
  x.pathname = `/${name}`;
  if (user) { x.username = user; x.password = pw ?? ""; }
  return x.toString();
};

/** Run SQL text; returns stdout. Throws with the psql error on failure unless allowFail. */
export function psql(url, sql, { vars = {}, allowFail = false } = {}) {
  const args = [url, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const r = spawnSync(PSQL, args, { input: sql, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`psql failed: ${(r.stderr || r.stdout).trim()}`);
  return { out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), status: r.status };
}
export function psqlFile(url, file, opts = {}) {
  return psql(url, fs.readFileSync(file, "utf8"), opts);
}
export const q = (url, sql) => psql(url, sql).out;

function migrationsCopy({ includeSecC }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secc-mig-"));
  fs.mkdirSync(path.join(dir, "prisma"));
  fs.copyFileSync(path.join(ROOT, "prisma/schema.prisma"), path.join(dir, "prisma/schema.prisma"));
  fs.cpSync(path.join(ROOT, "prisma/migrations"), path.join(dir, "prisma/migrations"), { recursive: true });
  const mig = path.join(dir, "prisma/migrations");
  fs.renameSync(path.join(mig, BACKDATED), path.join(mig, BACKDATED_AS));
  if (!includeSecC) {
    for (const d of fs.readdirSync(mig)) if (d.startsWith(SEC_C_PREFIX)) fs.rmSync(path.join(mig, d), { recursive: true });
  }
  return dir;
}

function migrateDeploy(dbUrl, includeSecC) {
  const dir = migrationsCopy({ includeSecC });
  const prismaBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
  const r = spawnSync(prismaBin, ["migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: dir, env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }, encoding: "utf8",
    shell: process.platform === "win32",
  });
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp copy; Windows may hold a handle */ }
  if (r.status !== 0) throw new Error(`migrate deploy failed:\n${(r.stdout + r.stderr).split("\n").slice(-25).join("\n")}`);
  psql(dbUrl, `UPDATE "_prisma_migrations" SET migration_name = '${BACKDATED}' WHERE migration_name = '${BACKDATED_AS}';`);
  return r.stdout + r.stderr;
}

function hashTree() {
  const h = crypto.createHash("sha256");
  const mig = path.join(ROOT, "prisma/migrations");
  for (const d of fs.readdirSync(mig).sort()) {
    if (d.startsWith(SEC_C_PREFIX)) continue;
    const f = path.join(mig, d, "migration.sql");
    if (fs.existsSync(f)) h.update(d).update(fs.readFileSync(f));
  }
  for (const f of fs.readdirSync(path.join(ROOT, "scripts/security")).filter((x) => x.endsWith("-grants.sql")).sort()) {
    h.update(f).update(fs.readFileSync(path.join(ROOT, "scripts/security", f)));
  }
  return h.digest("hex").slice(0, 12);
}

export const GRANT_VARS = { ROLE: "app_runtime", LOGIN_ROLE: "secc_admin_login", CTL_LOGIN_ROLE: "secc_ctl_login" };

function ensureTemplate() {
  const tpl = `secc_tpl_${hashTree()}`;
  const admin = ADMIN_URL;
  if (q(admin, `SELECT count(*) FROM pg_database WHERE datname='${tpl}'`) === "1") return tpl;
  console.log(`[secc-lab] building template ${tpl} (prisma migrate deploy, base migrations + grant scripts)`);
  psql(admin, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='secc_admin_login') THEN CREATE ROLE secc_admin_login NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='secc_ctl_login') THEN CREATE ROLE secc_ctl_login NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    END $$;`);
  const building = `${tpl}_building`;
  psql(admin, `DROP DATABASE IF EXISTS ${building} WITH (FORCE);`);
  psql(admin, `CREATE DATABASE ${building};`);
  const url = withDb(admin, building);
  migrateDeploy(url, false);
  for (const f of fs.readdirSync(path.join(ROOT, "scripts/security")).filter((x) => x.endsWith("-grants.sql")).sort()) {
    psqlFile(url, path.join(ROOT, "scripts/security", f), { vars: GRANT_VARS });
  }
  psql(admin, `ALTER DATABASE ${building} RENAME TO ${tpl};`);
  return tpl;
}

/**
 * A NEW database + NEW login roles for one proof.
 * opts.secC      (default true)  deploy the sec(C) migrations onto the clone
 * opts.beforeSecC(ownerUrl)      hook run on the clone BEFORE the sec(C) migrations
 */
export async function newLab(label, opts = {}) {
  const { secC = true, beforeSecC } = opts;
  const tpl = ensureTemplate();
  const nonce = `${label.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 16)}_${crypto.randomBytes(4).toString("hex")}`;
  const db = `secc_${nonce}`;
  const pw = crypto.randomBytes(12).toString("hex");
  const roles = { rt: `secc_rt_${nonce}`, auth: `secc_au_${nonce}`, adm: `secc_ad_${nonce}` };
  const admin = ADMIN_URL;
  psql(admin, `CREATE DATABASE ${db} TEMPLATE ${tpl};`);
  psql(admin, `
    CREATE ROLE ${roles.rt}   LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT IN ROLE app_runtime;
    CREATE ROLE ${roles.auth} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT IN ROLE app_auth;
    CREATE ROLE ${roles.adm}  LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT IN ROLE app_admin;`);
  const ownerUrl = withDb(admin, db);
  if (beforeSecC) await beforeSecC(ownerUrl);
  let deployLog = "";
  if (secC) deployLog = migrateDeploy(ownerUrl, true);
  const lab = {
    db, roles, ownerUrl, deployLog,
    rtUrl: withDb(admin, db, roles.rt, pw),
    authUrl: withDb(admin, db, roles.auth, pw),
    admUrl: withDb(admin, db, roles.adm, pw),
  };
  console.log(`[secc-lab] ${label}: database ${db} (fresh clone of ${tpl}${secC ? " + sec(C) migrations" : ""}), runtime ${roles.rt}`);
  return lab;
}

export function dropLab(lab) {
  try {
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${lab.db} WITH (FORCE);`);
    for (const r of Object.values(lab.roles)) psql(ADMIN_URL, `DROP ROLE IF EXISTS ${r};`);
  } catch (e) {
    console.log(`[secc-lab] teardown incomplete (${String(e.message).split("\n")[0]}) — harmless: the next proof gets a new database`);
  }
}
