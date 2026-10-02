#!/usr/bin/env node
// migration-security-classifier — PROPOSAL PROTOTYPE (not wired into any workflow).
//
// Classifies a Prisma migration as AUTHORITY-CHANGING when its SQL changes who
// may do what in the database: roles, memberships, privileges, default
// privileges, row-level security, policies, ownership, SECURITY DEFINER code or
// session identity. Such a migration must not reach Production merely because it
// is on main and someone dispatched release-migrate (the 2026-10-01 #594 apply).
//
//   node scripts/ci/migration-security-classifier.mjs <migration_dir>...   classify
//   node scripts/ci/migration-security-classifier.mjs --all                 every migration
//   node scripts/ci/migration-security-classifier.mjs --self-test
//
// Comments are stripped before matching, so prose never classifies a file.
// Pure: no network, no database, no secrets.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const RULES = [
  ["ROLE", /\b(CREATE|ALTER|DROP)\s+(ROLE|USER|GROUP)\b/i],
  ["GRANT", /\bGRANT\b/i],
  ["REVOKE", /\bREVOKE\b/i],
  ["DEFAULT_PRIVILEGES", /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i],
  ["RLS", /\b(ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ["POLICY", /\b(CREATE|ALTER|DROP)\s+POLICY\b/i],
  ["OWNER", /\bOWNER\s+TO\b/i],
  ["SECURITY_DEFINER", /\bSECURITY\s+DEFINER\b/i],
  ["SESSION_IDENTITY", /\bSET\s+(LOCAL\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b/i],
  ["ROLE_ATTRIBUTE", /\b(BYPASSRLS|SUPERUSER|CREATEROLE|CREATEDB|REPLICATION)\b/i],
];

export function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Returns the rule names that match; an empty list means not authority-changing. */
export function classify(sql) {
  const body = stripSqlComments(sql);
  return RULES.filter(([, re]) => re.test(body)).map(([name]) => name);
}

function selfTest() {
  let failed = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
  };
  t("plain DDL is not authority-changing", classify('CREATE TABLE "X" (id int); ALTER TABLE "X" ADD COLUMN y int;'), []);
  t("a comment mentioning GRANT does not classify", classify("-- we do not GRANT anything here\nCREATE INDEX i ON t(x);"), []);
  t("block comments are stripped", classify("/* REVOKE ALL */ SELECT 1;"), []);
  t("GRANT classifies", classify("GRANT SELECT ON t TO r;"), ["GRANT"]);
  t("REVOKE inside DO classifies", classify("DO $$ BEGIN REVOKE DELETE ON t FROM r; END $$;"), ["REVOKE"]);
  t("CREATE ROLE classifies; NO-prefixed attributes are not escalations", classify("CREATE ROLE x NOLOGIN NOBYPASSRLS;"), ["ROLE"]);
  t("an escalating role attribute classifies", classify("ALTER ROLE x BYPASSRLS;"), ["ROLE", "ROLE_ATTRIBUTE"]);
  t("FORCE RLS + policy classify", classify('ALTER TABLE "T" FORCE ROW LEVEL SECURITY; CREATE POLICY p ON "T" USING (true);'), ["RLS", "POLICY"]);
  t("default privileges classify (and their GRANT)", classify("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO r;"), ["GRANT", "DEFAULT_PRIVILEGES"]);
  t("ownership classifies", classify('ALTER TABLE "T" OWNER TO someone;'), ["OWNER"]);
  t("SECURITY DEFINER classifies", classify("CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1';"), ["SECURITY_DEFINER"]);
  console.log(failed === 0 ? "\nclassifier self-test: all passed" : `\nclassifier self-test: ${failed} FAILED`);
  process.exit(failed ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") selfTest();
else {
  const root = "prisma/migrations";
  const dirs = args[0] === "--all"
    ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : args;
  let n = 0;
  for (const d of dirs) {
    const f = existsSync(join(root, d, "migration.sql")) ? join(root, d, "migration.sql") : join(d, "migration.sql");
    const hits = classify(readFileSync(f, "utf8"));
    if (hits.length) { n++; console.log(`AUTHORITY  ${d}  [${hits.join(", ")}]`); }
    else if (args[0] !== "--all") console.log(`plain      ${d}`);
  }
  if (args[0] === "--all") console.log(`\n${n} of ${dirs.length} migrations are authority-changing`);
}
